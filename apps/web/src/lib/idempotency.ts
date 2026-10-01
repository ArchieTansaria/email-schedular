export interface SubmissionAttempt {
  key: string;
  signature: string;
}

export function resolveSubmissionAttempt(
  previous: SubmissionAttempt | null,
  signature: string,
  generate: () => string = () => crypto.randomUUID(),
): SubmissionAttempt {
  return previous?.signature === signature ? previous : { key: generate(), signature };
}
