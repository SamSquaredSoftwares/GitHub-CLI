/** Process exit codes used across the CLI. */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;

/**
 * An error that is safe to render to the user as a message rather than a
 * stack trace. `hint` is printed as a follow-up line when present.
 */
export class CliError extends Error {
  readonly exitCode: number;
  readonly hint: string | undefined;

  constructor(message: string, options: { exitCode?: number; hint?: string | undefined } = {}) {
    super(message);
    this.name = 'CliError';
    this.exitCode = options.exitCode ?? EXIT_ERROR;
    this.hint = options.hint;
  }
}

/** Bad flags, missing arguments, unknown commands. */
export class UsageError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, { exitCode: EXIT_USAGE, hint });
    this.name = 'UsageError';
  }
}
