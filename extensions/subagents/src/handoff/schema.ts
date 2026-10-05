export interface HandoffDocument {
  readonly summary: string;
  readonly currentState: string;
  readonly filesTouched: ReadonlyArray<string>;
  readonly checksRun: ReadonlyArray<string>;
  readonly openIssues: ReadonlyArray<string>;
  readonly nextSteps: ReadonlyArray<string>;
  readonly risks: ReadonlyArray<string>;
}
