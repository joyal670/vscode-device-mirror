import './vscode-stub';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { explainNetworkError } from '../tools';

describe('explainNetworkError', () => {
  for (const message of [
    "error: protocol fault (couldn't read status message): Undefined error: 0",
    "failed to connect to '192.168.1.6:5555': Host is down",
    'failed to connect to 10.0.0.2:5555: Connection refused',
    'cannot connect to 10.0.0.2:5555: Operation timed out',
  ]) {
    it(`adds the network hint to: ${message}`, () => {
      const err = explainNetworkError(message);
      assert.ok(err.message.startsWith(message));
      assert.match(err.message, /could not reach the device.*same network/);
    });
  }

  it('leaves other failures alone', () => {
    const message = 'Failed: Wrong password or connection was dropped.';
    assert.equal(explainNetworkError(message).message, message);
  });
});
