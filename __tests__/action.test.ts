// SPDX-License-Identifier: Apache-2.0
// Copyright The CDK Terrain Contributors

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as core from '@actions/core'
import * as exec from '@actions/exec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildNpxArgs, resolveCli, run } from '../src/action.js'
import { type ActionInputs, Engine, ExecutionMode } from '../src/models.js'

vi.mock('@actions/core')
vi.mock('@actions/exec')

function inputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  return {
    cdktnVersion: '0.23.3',
    cdktfVersion: '',
    useLocalCli: false,
    engine: Engine.OpenTofu,
    engineVersion: '',
    workingDirectory: './',
    mode: ExecutionMode.SynthOnly,
    stackName: '',
    cloudToken: '',
    githubToken: '',
    commentOnPr: false,
    updateComment: false,
    customNpxArgs: '',
    cdktnArgs: '',
    suppressOutput: false,
    ...overrides,
  }
}

describe('resolveCli', () => {
  it('runs cdktn-cli for cdktnVersion', () => {
    expect(resolveCli(inputs())).toEqual({ pkg: 'cdktn-cli', version: '0.23.3' })
  })

  it('runs the legacy cdktf-cli for cdktfVersion', () => {
    const cli = resolveCli(inputs({ cdktnVersion: '', cdktfVersion: '0.21.0' }))
    expect(cli).toEqual({ pkg: 'cdktf-cli', version: '0.21.0' })
  })

  it('prefers cdktnVersion when both are set', () => {
    const cli = resolveCli(inputs({ cdktnVersion: '0.23.3', cdktfVersion: '0.21.0' }))
    expect(cli.pkg).toBe('cdktn-cli')
  })
})

describe('buildNpxArgs', () => {
  it('builds a synth command', () => {
    expect(buildNpxArgs(inputs())).toEqual(['--yes', 'cdktn-cli@0.23.3', 'synth'])
  })

  it('builds a plan command for a stack', () => {
    const args = buildNpxArgs(inputs({ mode: ExecutionMode.PlanOnly, stackName: 'dev' }))
    expect(args).toEqual(['--yes', 'cdktn-cli@0.23.3', 'plan', 'dev'])
  })

  it('builds an auto-approved apply', () => {
    const args = buildNpxArgs(inputs({ mode: ExecutionMode.AutoApproveApply, stackName: 'dev' }))
    expect(args).toEqual(['--yes', 'cdktn-cli@0.23.3', 'apply', 'dev', '--auto-approve'])
  })

  it('builds an auto-approved destroy', () => {
    const args = buildNpxArgs(inputs({ mode: ExecutionMode.AutoApproveDestroy, stackName: 'dev' }))
    expect(args).toEqual(['--yes', 'cdktn-cli@0.23.3', 'destroy', 'dev', '--auto-approve'])
  })

  it('uses the legacy package for cdktfVersion', () => {
    const args = buildNpxArgs(inputs({ cdktnVersion: '', cdktfVersion: '0.21.0' }))
    expect(args).toEqual(['--yes', 'cdktf-cli@0.21.0', 'synth'])
  })

  it('threads custom npx and cdktn args', () => {
    const args = buildNpxArgs(
      inputs({
        mode: ExecutionMode.PlanOnly,
        stackName: 'dev',
        customNpxArgs: '--prefer-offline',
        cdktnArgs: '--var foo=bar',
      }),
    )
    expect(args).toEqual([
      '--yes',
      '--prefer-offline',
      'cdktn-cli@0.23.3',
      'plan',
      'dev',
      '--var',
      'foo=bar',
    ])
  })

  it('passes the outputs file to an apply', () => {
    const args = buildNpxArgs(
      inputs({ mode: ExecutionMode.AutoApproveApply, stackName: 'dev' }),
      '/tmp/outputs.json',
    )
    expect(args).toEqual([
      '--yes',
      'cdktn-cli@0.23.3',
      'apply',
      'dev',
      '--auto-approve',
      '--outputs-file',
      '/tmp/outputs.json',
    ])
  })

  it('only passes the outputs file to apply', () => {
    const args = buildNpxArgs(
      inputs({ mode: ExecutionMode.PlanOnly, stackName: 'dev' }),
      '/tmp/outputs.json',
    )
    expect(args).toEqual(['--yes', 'cdktn-cli@0.23.3', 'plan', 'dev'])
  })

  it('runs the project-local cdktn without fetching it', () => {
    const args = buildNpxArgs(
      inputs({
        cdktnVersion: '',
        useLocalCli: true,
        mode: ExecutionMode.PlanOnly,
        stackName: 'dev',
      }),
    )
    expect(args).toEqual(['--no', 'cdktn', 'plan', 'dev'])
  })

  it('ignores version inputs when running the local CLI', () => {
    const args = buildNpxArgs(inputs({ cdktfVersion: '0.21.0', useLocalCli: true }))
    expect(args).toEqual(['--no', 'cdktn', 'synth'])
  })

  it('threads custom npx args before the local CLI', () => {
    const args = buildNpxArgs(inputs({ useLocalCli: true, customNpxArgs: '--quiet' }))
    expect(args).toEqual(['--no', '--quiet', 'cdktn', 'synth'])
  })
})

describe('run', () => {
  let runnerTemp: string

  beforeEach(() => {
    vi.resetAllMocks()
    runnerTemp = mkdtempSync(join(tmpdir(), 'cdktn-action-'))
    vi.stubEnv('RUNNER_TEMP', runnerTemp)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(runnerTemp, { recursive: true, force: true })
  })

  /**
   * Drive run() in `mode` against a fake `tofu` and a fake CLI that exits with
   * `exitCode` and, unless `writesOutputs` is false, writes the outputs file.
   */
  async function runAction(
    mode: ExecutionMode,
    exitCode: number,
    writesOutputs = true,
  ): Promise<void> {
    const raw: Record<string, string> = {
      mode,
      stackName: 'dev',
      cdktnVersion: '0.24.0',
      engine: Engine.OpenTofu,
      commentOnPr: 'false',
    }
    vi.mocked(core.getInput).mockImplementation((name) => raw[name] ?? '')
    vi.mocked(core.getBooleanInput).mockImplementation((name) => raw[name] === 'true')
    vi.mocked(exec.getExecOutput).mockImplementation(async (cmd, args = []) => {
      if (cmd === Engine.OpenTofu) return { exitCode: 0, stdout: 'OpenTofu v1.12.3', stderr: '' }
      // Like the real CLI, write pretty-printed outputs wherever --outputs-file points.
      const flag = args.indexOf('--outputs-file')
      if (flag !== -1 && writesOutputs) {
        writeFileSync(
          args[flag + 1],
          JSON.stringify({ dev: { url: 'https://example.com' } }, null, 2),
        )
      }
      return { exitCode, stdout: '', stderr: '' }
    })
    await run()
  }

  function outputNames(): string[] {
    return vi.mocked(core.setOutput).mock.calls.map(([name]) => name)
  }

  it('sets the stack outputs as compact JSON after a successful apply', async () => {
    await runAction(ExecutionMode.AutoApproveApply, 0)
    expect(core.setOutput).toHaveBeenCalledWith(
      'stackOutputs',
      '{"dev":{"url":"https://example.com"}}',
    )
  })

  it('sets the stack outputs to {} when a successful apply writes no outputs file', async () => {
    await runAction(ExecutionMode.AutoApproveApply, 0, false)
    expect(core.setOutput).toHaveBeenCalledWith('stackOutputs', '{}')
  })

  it('does not set the stack outputs when the apply fails', async () => {
    await runAction(ExecutionMode.AutoApproveApply, 1)
    expect(outputNames()).toEqual(['exitCode', 'output'])
    expect(core.setFailed).toHaveBeenCalled()
  })

  it('does not set the stack outputs for a plan', async () => {
    await runAction(ExecutionMode.PlanOnly, 0)
    expect(outputNames()).toEqual(['exitCode', 'output'])
  })
})
