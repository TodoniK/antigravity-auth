import { redact } from '../logger/redact.js';
import { STDERR_TAIL_MAX_BYTES } from './command-runner.js';
const PI_INSTALL_ERROR_MESSAGE = 'Pi install failed; run pi install after checking your npm connection.';
function utf8Tail(value) {
    const bytes = Buffer.from(value, 'utf8');
    if (bytes.length <= STDERR_TAIL_MAX_BYTES)
        return value;
    let start = bytes.length - STDERR_TAIL_MAX_BYTES;
    while (start < bytes.length) {
        const byte = bytes[start];
        if (byte === undefined || (byte & 0xc0) !== 0x80)
            break;
        start++;
    }
    return bytes.subarray(start).toString('utf8');
}
function dropPartialLine(tail) {
    const newline = tail.indexOf('\n');
    return newline < 0 ? '' : tail.slice(newline + 1);
}
/**
 * Keeps the Pi install refusal message stable while exposing safe process details.
 * A clipped tail can start inside a credential, so discard its first line—or
 * the whole tail if it has no newline—before redacting.
 */
export class SetupCommandError extends Error {
    step = 'pi-install';
    exitCode;
    signal;
    stderrTail;
    constructor(details) {
        super(PI_INSTALL_ERROR_MESSAGE);
        this.name = 'SetupCommandError';
        this.exitCode = details.exitCode;
        this.signal = details.signal;
        const tail = details.stderrTruncated
            ? dropPartialLine(details.stderrTail)
            : details.stderrTail;
        const redacted = redact(tail);
        this.stderrTail = utf8Tail(typeof redacted === 'string' ? redacted : '');
    }
}
