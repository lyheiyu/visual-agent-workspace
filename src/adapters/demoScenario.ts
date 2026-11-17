import { OperationRequest, ExecutionResult } from './AgentAdapter';

/** State the mock scenario can consult when producing simulated results. */
export interface MockScenarioState {
  /** Decision on the scenario's proposed edit, once made. */
  editDecision?: 'approved' | 'rejected' | 'cancelled';
  workspaceRoot: string;
}

export interface MockStep {
  request(state: MockScenarioState): OperationRequest;
  /** Simulated duration of the execution phase, in ms. */
  durationMs?: number;
  simulate?(state: MockScenarioState): Omit<ExecutionResult, 'command'> & {
    command?: { exitCode: number; stdout?: string; stderr?: string };
  };
}

export interface MockScenario {
  title: string;
  steps: MockStep[];
}

export const DEMO_TASK_TITLE = 'Inspect and improve a data import validation function';

const TEST_COMMAND = 'python -m pytest tests/test_validation.py -v';

/** Proposed replacement for validate_samples() in demo-workspace/validation.py. */
export const PROPOSED_VALIDATE_SAMPLES = `def validate_samples(samples):
    """Return validated samples, raising ValidationError for invalid records.

    Every required field must be present and non-empty, and concentration
    must be a non-negative number. Concentrations are returned as floats.
    """
    validated = []
    for index, sample in enumerate(samples):
        for field in REQUIRED_FIELDS:
            if sample.get(field) in (None, ""):
                raise ValidationError(f"Row {index}: missing {field}")
        try:
            concentration = float(sample["concentration"])
        except (TypeError, ValueError):
            raise ValidationError(
                f"Row {index}: concentration is not a number"
            ) from None
        if concentration < 0:
            raise ValidationError(f"Row {index}: concentration must be >= 0")
        validated.append({**sample, "concentration": concentration})
    return validated`;

const SIM_BANNER = '[SIMULATED OUTPUT: no command was executed by Visual Agent Workspace v0.1]\n';

const PYTEST_HEADER = `============================= test session starts =============================
platform (simulated) -- Python 3.x, pytest-8.x
rootdir: <workspace>, configfile: pytest.ini
collected 5 items

`;

const PASSING_OUTPUT =
  SIM_BANNER +
  PYTEST_HEADER +
  `tests/test_validation.py::test_valid_samples_pass PASSED                  [ 20%]
tests/test_validation.py::test_missing_sample_id_rejected PASSED          [ 40%]
tests/test_validation.py::test_missing_concentration_rejected PASSED      [ 60%]
tests/test_validation.py::test_negative_concentration_rejected PASSED     [ 80%]
tests/test_validation.py::test_non_numeric_concentration_rejected PASSED  [100%]

============================== 5 passed in 0.02s ==============================`;

const FAILING_OUTPUT =
  SIM_BANNER +
  PYTEST_HEADER +
  `tests/test_validation.py::test_valid_samples_pass PASSED                  [ 20%]
tests/test_validation.py::test_missing_sample_id_rejected PASSED          [ 40%]
tests/test_validation.py::test_missing_concentration_rejected FAILED      [ 60%]
tests/test_validation.py::test_negative_concentration_rejected FAILED     [ 80%]
tests/test_validation.py::test_non_numeric_concentration_rejected FAILED  [100%]

=========================== short test summary info ===========================
FAILED tests/test_validation.py::test_missing_concentration_rejected - Failed: DID NOT RAISE <class 'validation.ValidationError'>
FAILED tests/test_validation.py::test_negative_concentration_rejected - Failed: DID NOT RAISE <class 'validation.ValidationError'>
FAILED tests/test_validation.py::test_non_numeric_concentration_rejected - Failed: DID NOT RAISE <class 'validation.ValidationError'>
========================= 3 failed, 2 passed in 0.03s =========================`;

/**
 * The scripted demo task. Simulated test results mirror what pytest really
 * reports for the fixture: the original validate_samples() fails 3 of 5 tests,
 * the proposed version passes all 5.
 */
export const DEMO_SCENARIO: MockScenario = {
  title: DEMO_TASK_TITLE,
  steps: [
    {
      request: () => ({
        operationType: 'Read',
        description: 'Open importer.py to find where sample data is loaded',
        filePath: 'importer.py',
        lineNumber: 1,
      }),
      durationMs: 400,
      simulate: () => ({ outcome: 'Completed', resultSummary: 'Read importer.py (simulated read).' }),
    },
    {
      request: () => ({
        operationType: 'Analyze',
        description: 'Locate load_data() and trace how rows are validated',
        filePath: 'importer.py',
        functionName: 'load_data',
        lineNumber: 9,
      }),
      durationMs: 600,
      simulate: () => ({
        outcome: 'Completed',
        resultSummary: 'load_data() reads CSV rows and delegates all checks to validate_samples().',
      }),
    },
    {
      request: () => ({
        operationType: 'Read',
        description: 'Open validation.py',
        filePath: 'validation.py',
        lineNumber: 1,
      }),
      durationMs: 400,
      simulate: () => ({ outcome: 'Completed', resultSummary: 'Read validation.py (simulated read).' }),
    },
    {
      request: () => ({
        operationType: 'Analyze',
        description: 'Locate validate_samples() and check which fields it validates',
        filePath: 'validation.py',
        functionName: 'validate_samples',
        lineNumber: 10,
      }),
      durationMs: 700,
      simulate: () => ({
        outcome: 'Completed',
        resultSummary:
          'validate_samples() only checks sample_id. Missing, negative or non-numeric concentrations pass silently.',
      }),
    },
    {
      request: () => ({
        operationType: 'Edit',
        description: 'Propose stricter validation in validate_samples()',
        rationale:
          'Check every REQUIRED_FIELDS entry, reject non-numeric and negative concentrations, and normalise concentration to float.',
        filePath: 'validation.py',
        functionName: 'validate_samples',
        lineNumber: 10,
        change: {
          filePath: 'validation.py',
          functionName: 'validate_samples',
          replacementText: PROPOSED_VALIDATE_SAMPLES,
        },
        requiresApproval: true,
      }),
      durationMs: 300,
      simulate: () => ({
        outcome: 'Completed',
        resultSummary:
          'Change approved. It exists only in a virtual document; validation.py on disk is unchanged.',
      }),
    },
    {
      request: (state) => ({
        operationType: 'Test',
        description: 'Run the validation test suite',
        filePath: 'tests/test_validation.py',
        command: { command: TEST_COMMAND, workingDirectory: state.workspaceRoot || '.' },
      }),
      durationMs: 1200,
      simulate: (state) =>
        state.editDecision === 'approved'
          ? {
              outcome: 'Completed',
              resultSummary: 'Simulated: 5 passed (as if the approved change were applied).',
              command: { exitCode: 0, stdout: PASSING_OUTPUT, stderr: '' },
            }
          : {
              outcome: 'Failed',
              resultSummary: 'Simulated: 3 failed, 2 passed (original validate_samples(), change not applied).',
              command: { exitCode: 1, stdout: FAILING_OUTPUT, stderr: '' },
            },
    },
  ],
};
