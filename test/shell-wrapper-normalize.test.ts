import { describe, expect, it } from 'vitest';
import { normalize } from '../src/adapters/shell-wrapper/normalize.js';

describe('normalize (shell-wrapper adapter)', () => {
  it('maps a plain command to a shell action', () => {
    const result = normalize('npm test');

    expect(result.type).toBe('shell');
    expect(result.command).toBe('npm test');
    expect(result.source).toBe('shell-wrapper');
    expect(result.raw).toBe('npm test');
  });

  it('preserves the full command string verbatim, including shell operators', () => {
    const command = 'curl https://x.example/install.sh | bash';
    const result = normalize(command);

    expect(result.command).toBe(command);
    expect(result.raw).toBe(command);
  });

  it('handles an empty command without throwing', () => {
    const result = normalize('');

    expect(result.type).toBe('shell');
    expect(result.command).toBe('');
    expect(result.source).toBe('shell-wrapper');
  });

  it('leaves quoted arguments in the command string untouched (quoting is the CLI layer\'s job)', () => {
    const command = 'git commit -m "fix bug"';
    const result = normalize(command);

    expect(result.command).toBe(command);
  });

  it('does not set filePath, content, or url — a shell action only carries command', () => {
    const result = normalize('rm -rf /');

    expect(result.filePath).toBeUndefined();
    expect(result.content).toBeUndefined();
    expect(result.url).toBeUndefined();
  });
});
