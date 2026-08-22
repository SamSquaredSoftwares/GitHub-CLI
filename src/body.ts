import { readFile } from 'node:fs/promises';
import { CliError, UsageError } from './errors.js';

/** Reads all of stdin. Injectable so tests need not touch the real stream. */
export type StdinReader = () => Promise<string>;

export const readProcessStdin: StdinReader = async () => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
};

export interface BodySource {
  body?: string | undefined;
  bodyFile?: string | undefined;
}

/**
 * Resolves the text body for a create command.
 *
 * `--body-file -` reads stdin, so a body can be piped in from another program
 * or a heredoc rather than squeezed onto the command line.
 */
export async function resolveBody(
  source: BodySource,
  readStdin: StdinReader = readProcessStdin,
): Promise<string | undefined> {
  if (source.body !== undefined && source.bodyFile !== undefined) {
    throw new UsageError('--body and --body-file cannot be combined.');
  }
  if (source.body !== undefined) return source.body;
  if (source.bodyFile === undefined) return undefined;
  if (source.bodyFile === '-') return readStdin();

  try {
    return await readFile(source.bodyFile, 'utf8');
  } catch (cause) {
    throw new CliError(`Could not read --body-file '${source.bodyFile}': ${(cause as Error).message}`, {
      hint: "Pass a readable file path, or '-' to read the body from stdin.",
    });
  }
}
