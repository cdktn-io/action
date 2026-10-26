# CDK Terrain Action

[![CI](https://github.com/cdktn-io/action/actions/workflows/ci.yml/badge.svg)](https://github.com/cdktn-io/action/actions/workflows/ci.yml)
[![Security](https://github.com/cdktn-io/action/actions/workflows/security.yml/badge.svg)](https://github.com/cdktn-io/action/actions/workflows/security.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

A GitHub Action that runs [CDK Terrain (CDKTN)](https://cdktn.io) — the
community-maintained CDK for Terraform fork — as part of your CI/CD workflow.
Synthesize, plan, apply or destroy a stack with **OpenTofu by default**
(auto-detected from `PATH`, or Terraform), and optionally report the result back
on the pull request.

This is an independent, clean-room reimplementation inspired by HashiCorp's
archived [`terraform-cdk-action`](https://github.com/hashicorp/terraform-cdk-action).
See [`NOTICE`](./NOTICE).

## Usage

This action **does not install the engine**; it verifies the binary is on `PATH`.
Run [`opentofu/setup-opentofu`](https://github.com/opentofu/setup-opentofu) (or
[`hashicorp/setup-terraform`](https://github.com/hashicorp/setup-terraform))
first. By default (`engine: auto`) the action detects whichever binary is on
`PATH`, preferring OpenTofu; set `engine: tofu`/`terraform` to force one. The
CDK Terrain CLI (`cdktn-cli`) is fetched on demand via `npx`.

> [!IMPORTANT]
> Disable the setup action's command wrapper (`tofu_wrapper: false` /
> `terraform_wrapper: false`) so CDK Terrain can call the binary directly.

### OpenTofu (default)

```yaml
jobs:
  plan:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write # only needed when commentOnPr is true
    steps:
      - uses: actions/checkout@v7

      - uses: actions/setup-node@v6
        with:
          node-version: 24

      - uses: opentofu/setup-opentofu@v2
        with:
          tofu_version: 1.12.3
          tofu_wrapper: false

      - uses: cdktn-io/action@v1
        with:
          mode: plan-only
          stackName: my-stack
          cdktnVersion: 0.24.0
          engineVersion: 1.12.3 # optional: require this exact tofu version
          githubToken: ${{ github.token }}
```

### Terraform

```yaml
      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: 1.13.3
          terraform_wrapper: false

      - uses: cdktn-io/action@v1
        with:
          mode: plan-only
          stackName: my-stack
          cdktnVersion: 0.24.0
          engine: terraform
          cloudToken: ${{ secrets.TF_API_TOKEN }}
```

## Inputs

| Input              | Required | Default | Description |
| ------------------ | -------- | ------- | ----------- |
| `mode`             | yes      | —       | `synth-only`, `plan-only`, `auto-approve-apply`, or `auto-approve-destroy`. |
| `cdktnVersion`     | yes¹     | —       | Version of `cdktn-cli` to run (fetched via `npx`). |
| `useLocalCli`      | no       | `false` | Run the CLI from the project's `node_modules` (`npx --no cdktn`) instead of fetching it, so its version follows the project's lockfile. Install dependencies first. |
| `stackName`        | for non-synth modes | — | Stack to operate on. Required for every mode except `synth-only`. |
| `engine`           | no       | `auto`  | Engine to drive: `auto` (detect, prefer OpenTofu), `tofu`, or `terraform`. Sets `TERRAFORM_BINARY_NAME`. |
| `engineVersion`    | no       | —       | Exact engine version that must be on `PATH`. Empty = only check presence. |
| `workingDirectory` | no       | `./`    | Directory the CDK Terrain project lives in. |
| `cloudToken`       | no       | —       | HCP Terraform / TFE token (exported as `TF_TOKEN_app_terraform_io`). |
| `githubToken`      | no       | —       | Token used to post the PR comment. No comment is posted if omitted. |
| `commentOnPr`      | no       | `true`  | Post the run result as a PR comment. |
| `updateComment`    | no       | `true`  | Update the previous comment for this config instead of adding a new one. |
| `customNpxArgs`    | no       | `""`    | Extra args passed to `npx` before the CLI package. |
| `cdktnArgs`        | no       | `""`    | Extra args passed to the `cdktn` command. |
| `suppressOutput`   | no       | `false` | Omit captured CLI output from the PR comment. |

¹ Provide either `cdktnVersion` or the deprecated `cdktfVersion`, or set `useLocalCli`; the action errors otherwise. With `useLocalCli`, the project-local `cdktn` runs and any version input is ignored.

### Deprecated inputs (accepted for migration)

| Deprecated            | Use instead    | Notes |
| --------------------- | -------------- | ----- |
| `cdktfVersion`        | `cdktnVersion` | Runs the legacy `cdktf-cli` package instead of `cdktn-cli`, easing migration from `hashicorp/terraform-cdk-action`. |
| `terraformVersion`    | `engineVersion`| — |
| `terraformCloudToken` | `cloudToken`   | — |
| `cdktfArgs`           | `cdktnArgs`    | — |

## Outputs

| Output         | Description |
| -------------- | ----------- |
| `exitCode`     | Exit code returned by the CLI invocation. |
| `output`       | Combined stdout/stderr captured from the CLI invocation. |
| `stackOutputs` | Stack output values as a JSON string keyed by stack name (from `cdktn apply --outputs-file`). Set only after a successful `auto-approve-apply`. Sensitive outputs are excluded. |

For example, to use a stack output as the deployment URL (the `|| '{}'` covers runs where `stackOutputs` is not set):

```yaml
jobs:
  deploy:
    environment:
      name: production
      url: ${{ fromJSON(steps.cdktn.outputs.stackOutputs || '{}').my-stack.url }}
    steps:
      # ...
      - id: cdktn
        uses: cdktn-io/action@v1
        with:
          cdktnVersion: 0.24.0
          mode: auto-approve-apply
          stackName: my-stack
```

## Modes

| Mode                   | command                              |
| ---------------------- | ------------------------------------ |
| `synth-only`           | `synth`                              |
| `plan-only`            | `plan <stackName>`                   |
| `auto-approve-apply`   | `apply <stackName> --auto-approve`   |
| `auto-approve-destroy` | `destroy <stackName> --auto-approve` |

## Development

The toolchain is pinned with [mise](https://mise.jdx.dev) and the bundle is
produced by [Rolldown](https://rolldown.rs); linting/formatting use
[Biome](https://biomejs.dev) and tests use [Vitest](https://vitest.dev).

The Node version is pinned in [`.nvmrc`](./.nvmrc) (mise reads it via
`idiomatic_version_file_enable_tools`), so `setup-node`/`nvm`/`mise` all agree.

```bash
mise install     # node (from .nvmrc), actionlint, zizmor
npm ci
npm run all      # biome check + typecheck + test + bundle dist/
```

> [!NOTE]
> When changing dependencies, regenerate the lockfile with `npm run relock`
> (clean install). A plain incremental `npm install` on macOS drops Linux-only
> optional binaries (`@rolldown/binding-linux-*`, `@emnapi/*`, …) from
> `package-lock.json`, which makes `npm ci` fail on the Linux CI runner.

Workflows are linted with `actionlint` and security-scanned with `zizmor`:

```bash
actionlint
zizmor .
```

### About `dist/`

The bundled `dist/index.js` is **committed on `main`** so GitHub can run the
action directly at any tag. The [`check-dist`](.github/workflows/check-dist.yml)
workflow rebuilds it on every change and fails if the committed bundle drifts
from source, so a tag always runs code that is reproducible from its reviewed
source. Releases additionally attach
[build provenance](https://github.com/cdktn-io/action/attestations).

## License

[Apache-2.0](./LICENSE)
