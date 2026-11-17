import { AskForApproval, SandboxMode } from './protocol';

export type CodexProfileId = 'observe' | 'approve-commands' | 'approve-edits';

/**
 * Safety profiles. Every profile uses Codex's READ-ONLY sandbox: shell
 * commands can never write to the workspace (verified on Windows: an approved
 * `Set-Content` failed with "Access to the path ... is denied").
 *
 * The only way a file can change is a Codex patch (`fileChange`) that the
 * user explicitly approves, and only in 'approve-edits'.
 */
export interface CodexProfile {
  id: CodexProfileId;
  label: string;
  sandbox: SandboxMode;
  approvalPolicy: AskForApproval;
  /** What happens when Codex asks to run a command. */
  commandApprovals: 'ask-user' | 'auto-decline';
  /** What happens when Codex asks to apply a patch. */
  fileChanges: 'ask-user' | 'auto-decline';
  /** Shown in the UI as the enforced boundary. */
  boundary: string;
  detail: string;
}

export const CODEX_PROFILES: Record<CodexProfileId, CodexProfile> = {
  observe: {
    id: 'observe',
    label: 'Observe only (read-only)',
    sandbox: 'read-only',
    approvalPolicy: 'on-request',
    commandApprovals: 'auto-decline',
    fileChanges: 'auto-decline',
    boundary:
      'Codex read-only sandbox. Commands run without asking and are OBSERVED only; every escalation or edit request is declined automatically.',
    detail: 'Codex reads and runs commands inside its read-only sandbox. You watch; nothing can be written.',
  },
  'approve-commands': {
    id: 'approve-commands',
    label: 'Approve each command (read-only)',
    sandbox: 'read-only',
    approvalPolicy: 'untrusted',
    commandApprovals: 'ask-user',
    fileChanges: 'auto-decline',
    boundary:
      'Codex read-only sandbox + approval policy "untrusted": Codex must ask before running commands (approved commands still run read-only). Edits are declined automatically.',
    detail: 'Codex must ask before each non-trusted command. Approved commands still cannot write. Edits are declined.',
  },
  'approve-edits': {
    id: 'approve-edits',
    label: 'Approve each command and each edit',
    sandbox: 'read-only',
    approvalPolicy: 'untrusted',
    commandApprovals: 'ask-user',
    fileChanges: 'ask-user',
    boundary:
      'Codex read-only sandbox + "untrusted": commands need approval and cannot write; a patch is applied only after you approve that whole patch (paths must be inside the workspace).',
    detail:
      'Codex must ask before each command and each patch. You review the full diff; approving applies that entire patch. Commands still cannot write.',
  },
};

export function getProfile(id: string | undefined): CodexProfile {
  return CODEX_PROFILES[(id ?? 'observe') as CodexProfileId] ?? CODEX_PROFILES.observe;
}
