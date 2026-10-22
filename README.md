# Amp → InstaBox provider

Run [Amp self-hosted orbs](https://ampcode.com/docs/orbs/self-hosted) on [InstaBox](https://instabox.sh/). Send a message in Amp and this provider creates or resumes an InstaBox VM for the thread. When Amp pauses the orb, the VM suspends. Deleting the orb deletes its VM and disk.

This is an independent adapter, not an official Amp or InstaBox integration. It uses InstaBox's TypeScript SDK and Amp's standard orb Docker image.

## How it works

An always-awake computer runs the provider. Amp sends it lifecycle jobs over an outbound HTTPS connection; the adapter calls InstaBox to manage the VMs. Each orb gets a separate Linux x64 VM and Docker container, which connect back to Amp. No public IP or inbound port is needed on the provider host.

The provider must stay awake while its VMs sleep. A Mac mini works, as does another persistent host with Node and Amp. The included background-service installer is for macOS; other platforms need their own service manager.

The adapter creates its own VMs. It does not adopt a machine you already created in the InstaBox dashboard.

## Requirements

- Node.js 22 or later, npm, and an Amp CLI with `amp orb provider` support.
- An Amp workspace with self-hosted orbs enabled and a custom orb provider token. Individuals can create a workspace too. Review Amp's credit and subscription billing changes when creating one.
- An InstaBox API key with `machines:write`, `machines:delete`, and `images:read` scopes.
- Capacity for one InstaBox VM per active or paused orb. Paused machines still count toward account limits.
- An InstaBox Linux x64 template with Docker running and accessible directly or through passwordless `sudo -n`. The default template is `agent-browser`.

## Set up

### 1. Install the provider on an awake host

Install the [Amp CLI](https://ampcode.com/docs/cli) if it is not already available. The official installer normally puts it at `~/.local/bin/amp`, which is this adapter's default location.

```sh
git clone https://github.com/MRL-00/amp-instabox-provider.git
cd amp-instabox-provider
npm ci --ignore-scripts
```

Keep this directory on persistent storage. The service uses its absolute path, so moving it later requires reinstalling the service.

### 2. Create the credentials

In your Amp workspace, open **Settings → Orbs**, enable self-hosted orbs, and add a provider named `instabox`. Copy the provider token; Amp shows it once.

Create an InstaBox API key using the [authenticated InstaBox CLI](https://instabox.sh/docs/cli):

```sh
instabox keys create --name amp-provider \
  --scope machines:write \
  --scope machines:delete \
  --scope images:read
```

The CLI's own saved login does not replace the API key used by the SDK in this adapter.

### 3. Configure and check

```sh
npm run configure
npm run doctor
```

The configurator asks for the InstaBox API key and Amp provider token without echoing them. It saves `config.json` with file mode `600`. The file is ignored by Git. Press Enter to keep a previously saved token when reconfiguring. Use an interactive terminal, or `ssh -t`, for these prompts.

`doctor` checks Amp's provider command and read access to InstaBox. It does not create a VM, check write permissions, or validate the Amp provider token. A real thread is needed for the full check.

Optional fields in the private `config.json`:

| Field | Default | Purpose |
| --- | --- | --- |
| `ampBin` | `~/.local/bin/amp` under your home directory | Absolute path to the Amp executable. Use a full path, not a literal tilde, when setting it yourself. |
| `template` | `agent-browser` | InstaBox template or permitted private base snapshot. |
| `providerId` | `amp-instabox` | Stable VM ownership namespace. Keep it unchanged after creating orbs. |

Run one provider process per namespace. To operate another independent provider against the same InstaBox account, give it a different `providerId` and Amp provider token. Changing the namespace does not migrate or remove existing VMs.

### 4. Start the provider

On macOS:

```sh
npm run install-service
```

This installs a user LaunchAgent named `com.github.mrl-00.amp-instabox-provider`, starts it immediately, and restarts it after failure and at login. It records the current Node executable path, so reinstall the service after moving or removing that Node installation.

Someone must log into the macOS account after a reboot. A user LaunchAgent does not run at the pre-login or FileVault unlock screen. Configure the host to stay awake.

To run in the foreground on macOS or Linux:

```sh
npm start
```

On Linux, use a service manager to keep that command running under the user who owns the private configuration. Do not run it alongside the macOS LaunchAgent or another copy of the same provider.

## Try it in Amp

Create a disposable project and thread. In the composer, choose **Orb → Self-Hosted → instabox**, then ask Amp to create a file. Archive the thread and check that its VM suspends in InstaBox. Reopen the thread and ask Amp to read the existing file without recreating it.

The same VM should resume with the file intact. Deleting this test thread should remove its VM and disk. Use a disposable thread when testing deletion.

The provider does not need to be your workspace default. You can continue choosing Amp-hosted orbs for other threads.

## Lifecycle and limits

| Amp job | Adapter behaviour |
| --- | --- |
| `spawn` | Find the orb's VM by ownership metadata, then create or resume it. Start the Docker container and launch `amp orb bootstrap` with the fresh orb token. |
| `pause` | Stop the container and suspend the VM without waking an already paused machine. Files survive; running container processes do not. |
| `delete` | Delete the owned VM and its disk without waking it. Repeated deletion succeeds when the VM is already absent. |

- **No project snapshot cache.** New threads run repository setup from the base image. Resumed threads retain their own VM and container filesystem. `ORB_SNAPSHOT_ID` is acknowledged in logs but not implemented as a cache.
- **Independent idle timers.** The adapter requests no automatic suspension, but InstaBox can retain its own timer on accounts without manual lifecycle control. It logs the effective timer. Amp-requested pause and resume have been tested; recovery after an independent InstaBox idle suspension has not.
- **One host per namespace.** Per-orb locks serialize jobs locally, not across multiple hosts. Listing failures fail the job instead of creating a replacement VM; multiple ownership matches fail instead of choosing a machine to delete.
- **Startup deadlines.** The initial spawn downloads Amp's Docker image. Guest startup has a three-minute timeout, and the dispatch process exits after 275 seconds. A failed startup attempts to pause the VM while keeping its disk. If a hard timeout or network failure occurs, inspect InstaBox: the remote operation may still have completed.
- **Successful dispatch is not a connection guarantee.** It means the detached bootstrap command was accepted. Check Amp's thread status to confirm the orb connected.
- **Credentials stay on the provider host.** The adapter forwards the short-lived orb token and server URL to the container. It does not forward the InstaBox API key or provider token, and it disables InstaBox Vault delivery on newly created VMs.
- **Other features need testing.** Desktop, portals and external agents have not been tested through this adapter. This supplies Amp self-hosted orbs; it does not register a standalone Claude Code cloud machine.

## Service operations on macOS

Logs are plain files under the checkout's `logs/` directory:

```sh
tail -n 60 logs/provider.log
tail -n 60 logs/provider-error.log
launchctl print "gui/$(id -u)/com.github.mrl-00.amp-instabox-provider"
```

Stop the background provider:

```sh
launchctl bootout "gui/$(id -u)/com.github.mrl-00.amp-instabox-provider"
```

Stopping the provider does not pause or delete its VMs. It prevents further lifecycle jobs until the provider is restarted. Run `npm run install-service` again to restart it. Rotate or remove old logs as needed.

## Validation and development

```sh
npm ci --ignore-scripts
npm test
```

The 14 automated tests cover the lifecycle, token forwarding, ownership isolation, retries, concurrent-job locking, invalid input, shell parsing, startup failure cleanup, and requests made by the pinned published SDK. They use mock responses and do not need credentials or create cloud VMs.

A live Amp thread was also tested on 23 October 2026: create, project setup, file creation, archive-triggered pause, resume from a new message with the same VM and retained file, then deletion. The initial provider job took about 39 seconds; the later wake job took about four seconds. These are observations from one test, not benchmarks or complete model response times.

The live test used the same lifecycle code as this repository. The public package generalises the local setup instructions, default ownership namespace and macOS service name.

## References

- [Amp self-hosted orbs announcement](https://ampcode.com/news/self-hosted-orbs)
- [Amp provider dispatch contract](https://ampcode.com/docs/orbs/self-hosted#dispatch-contract)
- [InstaBox SDK](https://instabox.sh/docs/sdk), pinned here to `0.5.3`
- [InstaBox CLI](https://instabox.sh/docs/cli)

## Licence

[MIT](LICENSE).
