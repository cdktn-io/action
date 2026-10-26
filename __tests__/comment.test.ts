// SPDX-License-Identifier: Apache-2.0
// Copyright The cdk-terrain-action Contributors

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildCommentBody,
  CommentController,
  commentMarker,
  extractRunUrl,
  hasNoChanges,
} from '../src/comment.js'
import { type ActionInputs, Engine, ExecutionMode } from '../src/models.js'

function inputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  return {
    cdktnVersion: '0.23.3',
    cdktfVersion: '',
    useLocalCli: false,
    engine: Engine.OpenTofu,
    engineVersion: '',
    workingDirectory: './',
    mode: ExecutionMode.PlanOnly,
    stackName: 'my-stack',
    cloudToken: '',
    githubToken: 'token',
    commentOnPr: true,
    updateComment: true,
    customNpxArgs: '',
    cdktnArgs: '',
    suppressOutput: false,
    ...overrides,
  }
}

describe('commentMarker', () => {
  it('is stable for the same configuration', () => {
    expect(commentMarker(inputs())).toBe(commentMarker(inputs()))
  })

  it('differs when the stack changes', () => {
    expect(commentMarker(inputs())).not.toBe(commentMarker(inputs({ stackName: 'other' })))
  })

  it('is wrapped as an HTML comment', () => {
    expect(commentMarker(inputs())).toMatch(/^<!-- cdktn-action:[0-9a-f]{16} -->$/)
  })
})

describe('hasNoChanges', () => {
  it('detects the no-changes message', () => {
    expect(hasNoChanges('Plan: No changes. Your infrastructure matches.')).toBe(true)
  })

  it('returns false when there are changes', () => {
    expect(hasNoChanges('Plan: 1 to add, 0 to change, 0 to destroy.')).toBe(false)
  })
})

describe('extractRunUrl', () => {
  it('finds an HCP Terraform run URL', () => {
    const url = 'https://app.terraform.io/app/acme/workspaces/ws/runs/run-AbC123'
    expect(extractRunUrl(`see ${url} for details`)).toBe(url)
  })

  it('returns undefined when absent', () => {
    expect(extractRunUrl('no url here')).toBeUndefined()
  })
})

describe('buildCommentBody', () => {
  it('uses the success icon and includes output by default', () => {
    const body = buildCommentBody(inputs(), 'Plan: 1 to add', true)
    expect(body).toContain('✅')
    expect(body).toContain('Show output')
    expect(body).toContain('Plan: 1 to add')
    expect(body).toContain('**Stack:** `my-stack`')
  })

  it('uses the no-changes icon', () => {
    expect(buildCommentBody(inputs(), 'No changes.', true)).toContain('🟰')
  })

  it('uses the failure icon', () => {
    expect(buildCommentBody(inputs(), 'boom', false)).toContain('❌')
  })

  it('omits output when suppressOutput is set', () => {
    const body = buildCommentBody(inputs({ suppressOutput: true }), 'secret output', true)
    expect(body).not.toContain('secret output')
    expect(body).not.toContain('Show output')
  })

  it('truncates very large output within the comment limit', () => {
    const body = buildCommentBody(inputs(), 'x'.repeat(100_000), true)
    expect(body.length).toBeLessThanOrEqual(65_000)
    expect(body).toContain('output truncated')
  })
})

describe('CommentController', () => {
  const repo = { owner: 'open-constructs', repo: 'cdk-terrain-action', sha: 'deadbeef' }
  let octokit: {
    rest: {
      repos: { listPullRequestsAssociatedWithCommit: ReturnType<typeof vi.fn> }
      issues: {
        listComments: ReturnType<typeof vi.fn>
        createComment: ReturnType<typeof vi.fn>
        updateComment: ReturnType<typeof vi.fn>
      }
    }
    paginate: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    octokit = {
      rest: {
        repos: { listPullRequestsAssociatedWithCommit: vi.fn() },
        issues: { listComments: vi.fn(), createComment: vi.fn(), updateComment: vi.fn() },
      },
      paginate: vi.fn().mockResolvedValue([]),
    }
  })

  // biome-ignore lint/suspicious/noExplicitAny: narrow mock stands in for Octokit
  const ctrl = () => new CommentController(octokit as any, { ...repo, prNumber: 7 })

  it('creates a new comment when none exists', async () => {
    await ctrl().upsert(inputs(), 'hello')
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 7, body: 'hello' }),
    )
    expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled()
  })

  it('updates the existing comment matching the marker', async () => {
    const marker = commentMarker(inputs())
    octokit.paginate.mockResolvedValue([{ id: 42, body: `prev ${marker}` }])
    await ctrl().upsert(inputs(), 'updated')
    expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 42, body: 'updated' }),
    )
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled()
  })

  it('always creates a new comment when updateComment is disabled', async () => {
    const marker = commentMarker(inputs())
    octokit.paginate.mockResolvedValue([{ id: 42, body: `prev ${marker}` }])
    await ctrl().upsert(inputs({ updateComment: false }), 'fresh')
    expect(octokit.rest.issues.createComment).toHaveBeenCalled()
    expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled()
  })

  it('resolves the PR from the commit when no PR number is in context', async () => {
    octokit.rest.repos.listPullRequestsAssociatedWithCommit.mockResolvedValue({
      data: [{ number: 99, state: 'open' }],
    })
    // biome-ignore lint/suspicious/noExplicitAny: narrow mock stands in for Octokit
    const controller = new CommentController(octokit as any, repo)
    await controller.upsert(inputs(), 'body')
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 99 }),
    )
  })

  it('skips commenting when no PR can be found', async () => {
    octokit.rest.repos.listPullRequestsAssociatedWithCommit.mockResolvedValue({ data: [] })
    // biome-ignore lint/suspicious/noExplicitAny: narrow mock stands in for Octokit
    const controller = new CommentController(octokit as any, repo)
    await controller.upsert(inputs(), 'body')
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled()
  })
})
