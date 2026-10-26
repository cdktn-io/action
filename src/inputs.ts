// SPDX-License-Identifier: Apache-2.0
// Copyright The CDK Terrain Contributors

import * as core from '@actions/core'
import {
  type ActionInputs,
  ENGINE_AUTO,
  Engine,
  type EnginePreference,
  ExecutionMode,
  modeRequiresStack,
} from './models.js'

function parseEngine(raw: string): EnginePreference {
  const valid = [ENGINE_AUTO, ...Object.values(Engine)]
  if (!valid.includes(raw)) {
    throw new Error(`Invalid engine "${raw}". Expected one of: ${valid.join(', ')}.`)
  }
  return raw as EnginePreference
}

/**
 * Read a canonical input, falling back to a deprecated alias for migration ease.
 * Warns when the deprecated alias is what supplied the value.
 */
function withDeprecated(canonical: string, deprecated: string): string {
  const value = core.getInput(canonical)
  if (value) return value
  const legacy = core.getInput(deprecated)
  if (legacy) {
    core.warning(`Input "${deprecated}" is deprecated; use "${canonical}" instead.`)
  }
  return legacy
}

function parseEnum<T extends Record<string, string>>(
  raw: string,
  enumObj: T,
  label: string,
): T[keyof T] {
  const valid = Object.values(enumObj)
  if (!valid.includes(raw)) {
    throw new Error(`Invalid ${label} "${raw}". Expected one of: ${valid.join(', ')}.`)
  }
  return raw as T[keyof T]
}

/** Read and validate all action inputs from the environment via @actions/core. */
export function getInputs(): ActionInputs {
  const mode = parseEnum(core.getInput('mode', { required: true }), ExecutionMode, 'mode')
  const stackName = core.getInput('stackName')
  if (modeRequiresStack(mode) && !stackName) {
    throw new Error(`The "stackName" input is required when mode is "${mode}".`)
  }

  const cdktnVersion = core.getInput('cdktnVersion')
  const cdktfVersion = core.getInput('cdktfVersion')
  const useLocalCli = core.getBooleanInput('useLocalCli')
  if (!cdktnVersion && !cdktfVersion && !useLocalCli) {
    throw new Error(
      'Provide a "cdktnVersion" (or the deprecated "cdktfVersion") input, or set "useLocalCli".',
    )
  }
  if (useLocalCli && (cdktnVersion || cdktfVersion)) {
    core.warning(
      'useLocalCli is set: the project-local cdktn runs and the version input is ignored.',
    )
  }
  if (cdktnVersion && cdktfVersion) {
    core.warning('Both "cdktnVersion" and "cdktfVersion" were set; using "cdktnVersion".')
  } else if (cdktfVersion) {
    core.warning('Input "cdktfVersion" is deprecated; migrate to "cdktnVersion".')
  }

  return {
    cdktnVersion,
    cdktfVersion,
    useLocalCli,
    engine: parseEngine(core.getInput('engine') || ENGINE_AUTO),
    engineVersion: withDeprecated('engineVersion', 'terraformVersion'),
    workingDirectory: core.getInput('workingDirectory') || './',
    mode,
    stackName,
    cloudToken: withDeprecated('cloudToken', 'terraformCloudToken'),
    githubToken: core.getInput('githubToken'),
    commentOnPr: core.getBooleanInput('commentOnPr'),
    updateComment: core.getBooleanInput('updateComment'),
    customNpxArgs: core.getInput('customNpxArgs'),
    cdktnArgs: withDeprecated('cdktnArgs', 'cdktfArgs'),
    suppressOutput: core.getBooleanInput('suppressOutput'),
  }
}
