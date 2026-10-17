/**
 * Keeps the Pi install refusal message stable while exposing safe process details.
 * A clipped tail can start inside a credential, so discard its first line—or
 * the whole tail if it has no newline—before redacting.
 */
export declare class SetupCommandError extends Error {
    readonly step = "pi-install";
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly stderrTail: string;
    constructor(details: {
        exitCode: number | null;
        signal: string | null;
        stderrTail: string;
        stderrTruncated?: boolean;
    });
}
