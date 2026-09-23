export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = 2,
    readonly details: Readonly<Record<string, unknown>> | null = null
  ) {
    super(message);
    this.name = "CliError";
  }
}
