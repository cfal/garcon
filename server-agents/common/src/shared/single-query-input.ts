// Captures stdin failures so drained output and the exit status take precedence over EPIPE.
export async function captureSingleQueryInputFailure(
  stdin: Bun.Subprocess['stdin'],
  input: string | undefined,
  provider: string,
): Promise<{ error: unknown } | undefined> {
  if (input == null) return;
  try {
    if (!stdin || typeof stdin === 'number') {
      throw new Error(`${provider} process stdin is unavailable`);
    }
    await stdin.write(input);
    await stdin.end();
  } catch (error) {
    return { error };
  }
}
