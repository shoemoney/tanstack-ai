import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MANAGED_LABELS,
  ensureManagedLabels,
  executeMutations,
  planLabelChanges,
} from './actions'
import { ACK_MARKER, REPRO_MARKER, buildAckComment } from './comments'
import { classifyPR } from './classify'
import { main, planSweep } from './sweep'
import * as collection from './collect'
import * as configuration from './config'
import * as environment from './env'
import * as github from './github'
import {
  NOW,
  comment,
  config,
  daysAgo,
  hoursAgo,
  makeIssue,
  makePR,
} from './fixtures'
import type { GitHubClient } from './github'
import type { Mutation } from './actions'
import type { RepoSnapshot } from './types'

function makeSnapshot(overrides: Partial<RepoSnapshot> = {}): RepoSnapshot {
  return {
    owner: 'TanStack',
    repo: 'ai',
    takenAt: NOW.toISOString(),
    prs: [],
    issues: [],
    discussions: [],
    recentlyClosed: [],
    ...overrides,
  }
}

function clientRejecting(status: number): {
  client: GitHubClient
  calls: Array<string>
} {
  const calls: Array<string> = []
  const client: GitHubClient = {
    graphql: async () => {
      throw new Error('not used')
    },
    rest: async (method, path) => {
      calls.push(`${method} ${path}`)
      throw new Error(
        `GitHub REST ${method} ${path} \u2192 HTTP ${status}: {"message":"nope"}`,
      )
    },
  }
  return { client, calls }
}

function clientRejectingWith(
  status: number,
  message: string,
): { client: GitHubClient; calls: Array<string> } {
  const calls: Array<string> = []
  const client: GitHubClient = {
    graphql: async () => {
      throw new Error('not used')
    },
    rest: async (method, path) => {
      calls.push(`${method} ${path}`)
      throw new Error(
        `GitHub REST ${method} ${path} \u2192 HTTP ${status}: ${JSON.stringify({ message })}`,
      )
    },
  }
  return { client, calls }
}

describe('ensureManagedLabels', () => {
  it('keeps going when the label already exists (422)', async () => {
    const { client, calls } = clientRejecting(422)
    await expect(ensureManagedLabels(client, 'TanStack/ai')).resolves.toBe(true)
    expect(calls).toHaveLength(MANAGED_LABELS.length)
  })

  it('does not fail the sweep when the token cannot write labels (403)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { client, calls } = clientRejecting(403)
    try {
      await expect(ensureManagedLabels(client, 'TanStack/ai')).resolves.toBe(
        false,
      )
      expect(calls).toHaveLength(1)
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })

  it.each([
    'API rate limit exceeded',
    'You have exceeded a secondary rate limit',
    'You have triggered an abuse detection mechanism',
  ])('surfaces a label-setup rate limit: %s', async (message) => {
    const { client, calls } = clientRejectingWith(403, message)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(ensureManagedLabels(client, 'TanStack/ai')).rejects.toThrow(
        message,
      )
      expect(calls).toHaveLength(1)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('still surfaces an unexpected failure (500)', async () => {
    const { client } = clientRejecting(500)
    await expect(ensureManagedLabels(client, 'TanStack/ai')).rejects.toThrow(
      '500',
    )
  })
})

describe('sweep execution', () => {
  const snapshot = makeSnapshot({
    prs: [makePR({ author: 'tom', assignees: ['alem'] })],
  })

  beforeEach(() => {
    vi.spyOn(configuration, 'loadConfig').mockResolvedValue(config)
    vi.spyOn(collection, 'collectSnapshot').mockResolvedValue(snapshot)
    vi.spyOn(environment, 'isDryRun').mockReturnValue(false)
    vi.spyOn(environment, 'resolveToken').mockResolvedValue('test-token')
    vi.spyOn(environment, 'writeStepSummary').mockResolvedValue()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => vi.restoreAllMocks())

  it('skips all planned writes after label setup is denied', async () => {
    const calls: Array<string> = []
    vi.spyOn(github, 'createGitHubClient').mockReturnValue({
      graphql: async () => {
        throw new Error('not used')
      },
      rest: async (method, path) => {
        calls.push(`${method} ${path}`)
        if (path === '/repos/TanStack/ai/labels') {
          throw new Error(
            'GitHub REST HTTP 403: Resource not accessible by integration',
          )
        }
        throw new Error('Unexpected mutation after label setup was denied')
      },
    })
    expect(planSweep(snapshot, config).mutations).toHaveLength(1)

    await main()

    expect(calls).toEqual(['POST /repos/TanStack/ai/labels'])
    expect(console.warn).toHaveBeenCalledOnce()
    expect(console.log).toHaveBeenCalledWith(
      'Skipped 1 mutation(s): label setup was denied.',
    )
    expect(console.log).not.toHaveBeenCalledWith('Executed 1 mutation(s).')
  })

  it.each([0, 1])(
    'reports only mutations completed before denial (%i completed)',
    async (completed) => {
      const prs = Array.from({ length: completed + 1 }, (_, i) =>
        makePR({ number: 100 + i, author: 'tom', assignees: ['alem'] }),
      )
      vi.mocked(collection.collectSnapshot).mockResolvedValue(
        makeSnapshot({ prs }),
      )
      const calls: Array<string> = []
      vi.spyOn(github, 'createGitHubClient').mockReturnValue({
        graphql: async () => {
          throw new Error('not used')
        },
        rest: async (method, path) => {
          calls.push(`${method} ${path}`)
          if (path === `/repos/TanStack/ai/issues/${100 + completed}/labels`) {
            throw new Error(
              'GitHub REST HTTP 403: Resource not accessible by integration',
            )
          }
          return null
        },
      })

      await main()

      expect(calls).toEqual([
        ...MANAGED_LABELS.map(() => 'POST /repos/TanStack/ai/labels'),
        ...prs.map(
          (pr) => `POST /repos/TanStack/ai/issues/${pr.number}/labels`,
        ),
      ])
      expect(console.warn).toHaveBeenCalledOnce()
      expect(console.log).toHaveBeenCalledWith(
        `Executed ${completed} mutation(s).`,
      )
      expect(console.log).not.toHaveBeenCalledWith(
        `Executed ${prs.length} mutation(s).`,
      )
    },
  )

  it.each([201, 422])(
    'executes planned writes after label setup returns %i',
    async (labelStatus) => {
      const calls: Array<string> = []
      vi.spyOn(github, 'createGitHubClient').mockReturnValue({
        graphql: async () => {
          throw new Error('not used')
        },
        rest: async (method, path) => {
          calls.push(`${method} ${path}`)
          if (path === '/repos/TanStack/ai/labels' && labelStatus === 422) {
            throw new Error('GitHub REST HTTP 422: label already exists')
          }
          return null
        },
      })

      await main()

      expect(calls).toEqual([
        ...MANAGED_LABELS.map(() => 'POST /repos/TanStack/ai/labels'),
        'POST /repos/TanStack/ai/issues/100/labels',
      ])
      expect(console.warn).not.toHaveBeenCalled()
      expect(console.log).toHaveBeenCalledWith('Executed 1 mutation(s).')
    },
  )
})

describe('executeMutations', () => {
  const labelMutation: Mutation = {
    kind: 'add-labels',
    number: 1401,
    labels: ['waiting-on: maintainer'],
  }
  const secondMutation: Mutation = {
    kind: 'add-labels',
    number: 1386,
    labels: ['has-pr'],
  }

  it('does not fail the sweep when the token cannot write (403 permission)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { client, calls } = clientRejectingWith(
      403,
      'Resource not accessible by integration',
    )
    const sleepImpl = vi.fn(async () => {})
    try {
      await expect(
        executeMutations(
          client,
          'TanStack/ai',
          [labelMutation, secondMutation],
          { pacingMs: 0, sleepImpl },
        ),
      ).resolves.toBe(0)
      // Stops at the first denial instead of retrying a call that cannot pass.
      expect(calls).toEqual(['POST /repos/TanStack/ai/issues/1401/labels'])
      expect(sleepImpl).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })

  it('still backs off and retries a genuine 403 secondary rate limit', async () => {
    const { client, calls } = clientRejectingWith(
      403,
      'You have exceeded a secondary rate limit',
    )
    const sleepImpl = vi.fn(async () => {})
    await expect(
      executeMutations(client, 'TanStack/ai', [labelMutation], {
        pacingMs: 0,
        sleepImpl,
      }),
    ).rejects.toThrow('403')
    expect(calls).toHaveLength(2)
    expect(sleepImpl).toHaveBeenCalledWith(60_000)
  })

  it('still surfaces an unexpected failure (500)', async () => {
    const { client } = clientRejecting(500)
    await expect(
      executeMutations(client, 'TanStack/ai', [labelMutation], {
        pacingMs: 0,
        sleepImpl: async () => {},
      }),
    ).rejects.toThrow('500')
  })
})

describe('planSweep', () => {
  it('assigns, acks, and labels a fresh unassigned PR', () => {
    const snapshot = makeSnapshot({
      prs: [makePR({ files: ['packages/ai-sandbox/src/x.ts'] })],
    })
    const plan = planSweep(snapshot, config)
    const kinds = plan.mutations.map((m) => m.kind)
    expect(kinds).toContain('assign')
    expect(kinds).toContain('comment')
    expect(kinds).toContain('add-labels')

    const assign = plan.mutations.find((m) => m.kind === 'assign')
    expect(assign).toMatchObject({ number: 100, assignee: 'tom' })
    const ack = plan.mutations.find((m) => m.kind === 'comment')
    expect(ack && 'body' in ack && ack.body).toContain(ACK_MARKER)
    expect(ack && 'body' in ack && ack.body).toContain('@tom')
  })

  it('is idempotent: assigned + already-acked + correctly-labeled PR → no mutations', () => {
    const snapshot = makeSnapshot({
      prs: [
        makePR({
          assignees: ['alem'],
          labels: ['waiting-on: maintainer'],
          timeline: [
            comment(
              'github-actions[bot]',
              daysAgo(1),
              `hi\n${ACK_MARKER}`,
              true,
            ),
          ],
        }),
      ],
    })
    expect(planSweep(snapshot, config).mutations).toHaveLength(0)
  })

  it('leaves suspected-spam PRs completely untouched', () => {
    const snapshot = makeSnapshot({
      prs: [
        makePR({
          authorAccountCreatedAt: daysAgo(3),
          additions: 1,
          deletions: 1,
          linkedIssues: [],
          authorAssociation: 'NONE',
        }),
      ],
    })
    const plan = planSweep(snapshot, config)
    expect(plan.mutations).toHaveLength(0)
    expect(plan.skippedAsSpam).toEqual([100])
  })

  it('skips drafts and bot PRs', () => {
    const snapshot = makeSnapshot({
      prs: [
        makePR({ number: 1, isDraft: true }),
        makePR({ number: 2, author: 'renovate[bot]', authorIsBot: true }),
      ],
    })
    expect(planSweep(snapshot, config).mutations).toHaveLength(0)
  })

  it('assigns roster-authored PRs to someone else without acking', () => {
    const snapshot = makeSnapshot({
      prs: [
        makePR({
          author: 'tom',
          authorAssociation: 'COLLABORATOR',
          files: ['packages/ai-sandbox/src/x.ts'],
        }),
      ],
    })
    const plan = planSweep(snapshot, config)
    const assign = plan.mutations.find((m) => m.kind === 'assign')
    expect(assign && 'assignee' in assign && assign.assignee).not.toBe('tom')
    expect(plan.mutations.some((m) => m.kind === 'comment')).toBe(false)
  })

  it('asks for a repro once, labels needs-repro and has-pr', () => {
    const snapshot = makeSnapshot({
      prs: [makePR({ linkedIssues: [200], assignees: ['alem'] })],
      issues: [
        makeIssue({ body: 'no links or code here', assignees: ['alem'] }),
      ],
    })
    const plan = planSweep(snapshot, config)
    const reproComment = plan.mutations.find(
      (m) => m.kind === 'comment' && m.body.includes(REPRO_MARKER),
    )
    expect(reproComment).toBeDefined()
    const labels = plan.mutations.find(
      (m) => m.kind === 'add-labels' && m.number === 200,
    )
    expect(labels && 'labels' in labels && labels.labels).toEqual(
      expect.arrayContaining(['needs-repro', 'has-pr']),
    )

    // second sweep: repro comment already present → no repeat
    const acked = makeSnapshot({
      prs: snapshot.prs,
      issues: [
        makeIssue({
          body: 'no links or code here',
          assignees: ['alem'],
          labels: ['needs-repro', 'has-pr', 'waiting-on: maintainer'],
          timeline: [
            comment(
              'github-actions[bot]',
              hoursAgo(3),
              `x\n${REPRO_MARKER}`,
              true,
            ),
          ],
        }),
      ],
    })
    const second = planSweep(acked, config)
    expect(
      second.mutations.filter((m) => m.kind === 'comment' && m.number === 200),
    ).toHaveLength(0)
  })

  it('caps comments per run and reports the overflow', () => {
    const tinyCap = { ...config, maxCommentsPerRun: 2 }
    const snapshot = makeSnapshot({
      prs: [1, 2, 3, 4].map((n) => makePR({ number: n, assignees: ['alem'] })),
    })
    const plan = planSweep(snapshot, tinyCap)
    expect(plan.mutations.filter((m) => m.kind === 'comment')).toHaveLength(2)
    expect(plan.commentsSuppressedByCap).toBe(2)
  })

  it('spreads fallback assignments across maintainers', () => {
    const snapshot = makeSnapshot({
      prs: [11, 12, 13].map((n) => makePR({ number: n, files: ['README.md'] })),
    })
    const plan = planSweep(snapshot, config)
    const assignees = plan.mutations
      .filter((m) => m.kind === 'assign')
      .map((m) => (m as { assignee: string }).assignee)
    expect(new Set(assignees).size).toBeGreaterThan(1)
  })
})

describe('planLabelChanges', () => {
  it('only touches managed labels', () => {
    const mutations = planLabelChanges(
      1,
      ['bug', 'waiting-on: author', 'help wanted'],
      ['waiting-on: maintainer'],
    )
    expect(mutations).toEqual([
      { kind: 'add-labels', number: 1, labels: ['waiting-on: maintainer'] },
      { kind: 'remove-label', number: 1, label: 'waiting-on: author' },
    ])
  })

  it('produces nothing when labels already match', () => {
    expect(
      planLabelChanges(1, ['bug', 'ready-to-merge'], ['ready-to-merge']),
    ).toEqual([])
  })
})

describe('buildAckComment', () => {
  it('renders warnings for missing changeset/E2E and conflicts', () => {
    const t = classifyPR(
      makePR({
        files: ['packages/ai/src/core/chat.ts'],
        mergeable: 'CONFLICTING',
      }),
      config,
      NOW,
    )
    const body = buildAckComment(t, 'alem')
    expect(body).toContain('⚠️ No changeset found')
    expect(body).toContain('⚠️ No E2E test changes')
    expect(body).toContain('⚠️ Merge conflicts')
    expect(body).toContain('✅ CI passing')
    expect(body).toContain(ACK_MARKER)
  })
})
