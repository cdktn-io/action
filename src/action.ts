// SPDX-License-Identifier: Apache-2.0
// Copyright The CDK Terrain Contributors

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as github from '@actions/github'
import { buildCommentBody, CommentController, type RepoContext } from './comment.js'
import { resolveEngine } from './ensure-binary.js'
import { getInputs } from './inputs.js'
import { type ActionInputs, type CliSelection, type Engine, ExecutionMode } from './models.js'

/** Split a raw CLI-args string into argv tokens (whitespace separated). */
function splitArgs(raw: string): string[] {
  return raw.split(/\s+/).filter((token) => token.length > 0)
}

/**
 * Pick the CLI package to run. `cdktnVersion` runs CDK Terrain's `cdktn-cli`;
 * the deprecated `cdktfVersion` runs the legacy `cdktf-cli` for migration ease.
 */
export function resolveCli(inputs: ActionInputs): CliSelection {
  if (inputs.cdktnVersion) {
    return { pkg: 'cdktn-cli', version: inputs.cdktnVersion }
  }
  return { pkg: 'cdktf-cli', version: inputs.cdktfVersion }
}

/**
 * Map an execution mode to the CLI sub-command and its arguments. Only apply
 * uses `outputsFile`.
 */
function engineCommand(inputs: ActionInputs, outputsFile?: string): string[] {
  switch (inputs.mode) {
    case ExecutionMode.SynthOnly:
      return ['synth']
    case ExecutionMode.PlanOnly:
      return ['plan', inputs.stackName]
    case ExecutionMode.AutoApproveApply:
      return [
        'apply',
        inputs.stackName,
        '--auto-approve',
        // Supported by cdktn-cli (0.24.0) and legacy cdktf-cli (0.21.0) alike;
        // sensitive outputs are left out unless
        // --outputs-file-include-sensitive-outputs is also passed.
        ...(outputsFile ? ['--outputs-file', outputsFile] : []),
      ]
    case ExecutionMode.AutoApproveDestroy:
      return ['destroy', inputs.stackName, '--auto-approve']
  }
}

/** Assemble the full `npx` argv that runs the selected CDK CLI. */
export function buildNpxArgs(inputs: ActionInputs, outputsFile?: string): string[] {
  // The project-local cdktn comes from node_modules (`--no`: never download
  // one); otherwise fetch the requested CLI version on demand.
  const args = [inputs.useLocalCli ? '--no' : '--yes']
  args.push(...splitArgs(inputs.customNpxArgs))
  if (inputs.useLocalCli) {
    args.push('cdktn')
  } else {
    const cli = resolveCli(inputs)
    args.push(`${cli.pkg}@${cli.version}`)
  }
  args.push(...engineCommand(inputs, outputsFile))
  args.push(...splitArgs(inputs.cdktnArgs))
  return args
}

/**
 * Outputs file for this step: under RUNNER_TEMP so it stays out of the
 * project tree, and keyed by pid so several steps in one job don't collide.
 */
function outputsFilePath(): string {
  return join(process.env.RUNNER_TEMP || tmpdir(), `cdktn-outputs-${process.pid}.json`)
}

/** Return the outputs file as compact JSON, or `{}` when the file is absent; throws on invalid JSON. */
async function readStackOutputs(outputsFile: string): Promise<string> {
  if (!existsSync(outputsFile)) return '{}'
  return JSON.stringify(JSON.parse(await readFile(outputsFile, 'utf8')))
}

function buildEnv(inputs: ActionInputs): { [key: string]: string } {
  // @actions/exec wants a fully-defined string map, so drop any undefined vars.
  const env: { [key: string]: string } = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  // Tell CDK Terrain / CDKTF which provisioning engine to drive.
  env.TERRAFORM_BINARY_NAME = inputs.engine
  env.FORCE_COLOR = '0'
  env.TF_CLI_ARGS = '-no-color'
  if (inputs.cloudToken) {
    env.TF_TOKEN_app_terraform_io = inputs.cloudToken
  }
  return env
}

function repoContext(): RepoContext {
  const { owner, repo } = github.context.repo
  return {
    owner,
    repo,
    sha: github.context.sha,
    prNumber: github.context.payload.pull_request?.number,
  }
}

export async function run(): Promise<void> {
  const inputs = getInputs()

  // Resolve `auto` to a concrete engine (and verify the binary is present) so
  // everything downstream — env, comment, marker — uses the real engine.
  const engine: Engine = await resolveEngine(inputs.engine, inputs.engineVersion)
  inputs.engine = engine

  if (inputs.cloudToken) {
    core.setSecret(inputs.cloudToken)
  }

  const outputsFile = inputs.mode === ExecutionMode.AutoApproveApply ? outputsFilePath() : undefined
  const args = buildNpxArgs(inputs, outputsFile)
  core.info(`Running: npx ${args.join(' ')} (engine: ${inputs.engine})`)

  const result = await exec.getExecOutput('npx', args, {
    cwd: inputs.workingDirectory,
    env: buildEnv(inputs),
    ignoreReturnCode: true,
  })

  const output = `${result.stdout}\n${result.stderr}`.trim()
  const success = result.exitCode === 0

  core.setOutput('exitCode', result.exitCode)
  core.setOutput('output', output)
  // Publish outputs only for a successful apply, so later steps never act on a failed deploy.
  if (outputsFile && success) {
    core.setOutput('stackOutputs', await readStackOutputs(outputsFile))
  }

  if (inputs.commentOnPr) {
    if (inputs.githubToken) {
      const controller = new CommentController(github.getOctokit(inputs.githubToken), repoContext())
      await controller.upsert(inputs, buildCommentBody(inputs, output, success))
    } else {
      core.warning('commentOnPr is enabled but no githubToken was provided; skipping comment.')
    }
  }

  if (!success) {
    core.setFailed(`${engineCommand(inputs).join(' ')} failed with exit code ${result.exitCode}.`)
  }
}
