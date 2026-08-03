/**
 * Resource link detection.
 *
 * Two halves, split by what they cost:
 *
 *   - **`classify`** is pure, so the detection rules are tested directly and
 *     thoroughly against in-memory fixtures. Every signal, and every lookalike
 *     we deliberately refuse, gets a case.
 *   - **`detectResource`** is tested against a local HTTP server rather than a
 *     stub, because the part worth asserting is how a *failed* fetch is
 *     reported, and a stub would assert none of it.
 *
 * Several cases here are regressions for bugs that made the classifier quietly
 * useless rather than visibly broken: a 404 answered as HTTP 400, a GitHub repo
 * whose name was never read, manifests found only at the repository root, and a
 * documentation link that turned every local server remote. Each is marked
 * where it appears.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';

import AdmZip from 'adm-zip';

import { cleanupHome } from './helpers.ts';

type DetectModule = typeof import('../src/services/resources/detect.ts');

let detect: DetectModule;

/** An in-memory archive entry. */
function file(name: string, content: string): { name: string; data: Buffer } {
  return { name, data: Buffer.from(content, 'utf8') };
}

const SKILL_MD = `---
name: pdf-filler
description: Fills PDF forms from structured data.
---

# PDF Filler

Body text.
`;

before(async () => {
  detect = await import('../src/services/resources/detect.ts');
});

after(async () => {
  await cleanupHome();
});

// ---------------------------------------------------------------------------

describe('classify: skills', () => {
  it('recognises a SKILL.md and previews its manifest', () => {
    const result = detect.classify([file('SKILL.md', SKILL_MD)]);

    assert.equal(result.type, 'skill');
    assert.equal(result.confidence, 'strong');
    assert.equal(result.skillPreview?.name, 'pdf-filler');
    assert.equal(result.skillPreview?.description, 'Fills PDF forms from structured data.');
    assert.equal(result.mcpPreview, undefined);
  });

  it('finds a SKILL.md nested inside the archive', () => {
    const result = detect.classify([
      file('README.md', '# Bundle'),
      file('skills/filler/SKILL.md', SKILL_MD),
    ]);

    assert.equal(result.type, 'skill');
    assert.equal(result.skillPreview?.name, 'pdf-filler');
  });

  it('prefers the shallowest SKILL.md when there are several', () => {
    const result = detect.classify([
      file('nested/deep/SKILL.md', '# Deep\n\nWrong one.'),
      file('SKILL.md', SKILL_MD),
    ]);

    assert.equal(result.skillPreview?.name, 'pdf-filler');
  });

  it('still classifies when the SKILL.md will not parse', () => {
    // Losing the preview must not lose the classification.
    const result = detect.classify([file('SKILL.md', '\u0000\u0000')]);

    assert.equal(result.type, 'skill');
    assert.equal(result.confidence, 'strong');
  });

  it('does not treat a README as a skill', () => {
    // Intake falls back to README for a name; detection must not, or every
    // repository on earth would look like a skill.
    const result = detect.classify([file('README.md', '# Some tool\n\nDoes a thing.')]);

    assert.equal(result.type, 'invalid');
  });
});

describe('classify: MCP strong signals', () => {
  it('reads an npm SDK dependency', () => {
    const pkg = JSON.stringify({
      name: 'notes-server',
      dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' },
    });
    const result = detect.classify([file('package.json', pkg)]);

    assert.equal(result.type, 'mcp-server');
    assert.equal(result.confidence, 'strong');
    assert.match(result.reason, /@modelcontextprotocol\/sdk/);
    assert.equal(result.mcpPreview?.suggestedName, 'notes-server');
  });

  it('reads an SDK dependency from a nested package.json', () => {
    // Regression: manifest lookups were anchored to the repository root, so a
    // server living in a subdirectory produced no signal at all.
    const pkg = JSON.stringify({
      name: 'nested-server',
      dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' },
    });
    const result = detect.classify([file('README.md', '# Monorepo'), file('server/package.json', pkg)]);

    assert.equal(result.type, 'mcp-server');
    assert.equal(result.confidence, 'strong');
  });

  it('reads a devDependency too', () => {
    const pkg = JSON.stringify({ devDependencies: { '@modelcontextprotocol/server-github': '^1.0.0' } });

    assert.equal(detect.classify([file('package.json', pkg)]).confidence, 'strong');
  });

  it('reads a bare requirements.txt dependency', () => {
    const result = detect.classify([file('requirements.txt', 'httpx>=0.27\nmcp>=1.0\n')]);

    assert.equal(result.type, 'mcp-server');
    assert.equal(result.confidence, 'strong');
  });

  it('reads a quoted pyproject.toml dependency', () => {
    // Regression: only a bare line-initial name was matched, which missed the
    // array form every modern pyproject uses.
    const pyproject = `[project]
name = "notes"
dependencies = ["mcp>=1.0", "httpx"]
`;
    const result = detect.classify([file('pyproject.toml', pyproject)]);

    assert.equal(result.type, 'mcp-server');
    assert.equal(result.confidence, 'strong');
  });

  it('reads an mcpServers config block in the README', () => {
    const readme = `# Notes

Add this to your config:

\`\`\`json
{ "mcpServers": { "notes": { "command": "notes-server" } } }
\`\`\`
`;
    const result = detect.classify([file('README.md', readme)]);

    assert.equal(result.type, 'mcp-server');
    assert.equal(result.confidence, 'strong');
  });

  it('ignores manifests vendored under node_modules', () => {
    // A repository that depends on an MCP client is not itself an MCP server.
    const pkg = JSON.stringify({ dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' } });
    const result = detect.classify([file('node_modules/some-lib/package.json', pkg)]);

    assert.equal(result.type, 'invalid');
  });

  it('does not mistake a lookalike package name for the SDK', () => {
    const result = detect.classify([file('requirements.txt', 'mcpx-tools>=2.0\n')]);

    assert.equal(result.type, 'invalid');
  });
});

describe('classify: MCP weak signals', () => {
  it('reads the repository name out of a GitHub URL', () => {
    // Regression: the name was taken from the last path segment of the
    // *resolved* codeload URL, which is always "HEAD" — so a repository called
    // mcp-server-anything never produced a naming hint.
    const result = detect.classify(
      [file('README.md', '# Files\n\nDoes things with files.')],
      'https://github.com/acme/mcp-server-files',
    );

    assert.equal(result.type, 'mcp-server');
    assert.equal(result.confidence, 'weak');
    assert.equal(result.mcpPreview?.suggestedName, 'mcp-server-files');
  });

  it('reads the repository name out of a GitHub tree URL', () => {
    const result = detect.classify(
      [file('README.md', '# Files')],
      'https://github.com/acme/mcp-server-files/tree/main',
    );

    assert.equal(result.type, 'mcp-server');
    assert.equal(result.mcpPreview?.suggestedName, 'mcp-server-files');
  });

  it('reads a package name with no SDK dependency', () => {
    const pkg = JSON.stringify({ name: '@acme/mcp-notes' });
    const result = detect.classify([file('package.json', pkg)]);

    assert.equal(result.type, 'mcp-server');
    assert.equal(result.confidence, 'weak');
    assert.equal(result.mcpPreview?.suggestedName, 'mcp-notes');
  });

  it('reads a bare README mention', () => {
    const result = detect.classify([
      file('README.md', '# Toolkit\n\nAn experimental Model Context Protocol bridge.'),
    ]);

    assert.equal(result.type, 'mcp-server');
    assert.equal(result.confidence, 'weak');
  });

  it('does not fire on a name that merely contains the letters mcp', () => {
    const result = detect.classify([file('package.json', JSON.stringify({ name: 'mcphersons-tools' }))]);

    assert.equal(result.type, 'invalid');
  });
});

describe('classify: local vs remote', () => {
  it('treats a documented endpoint as remote', () => {
    const readme = '# Notes\n\nConnect to https://notes.example.com/sse to use the hosted server.';
    const pkg = JSON.stringify({ dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' } });
    const result = detect.classify([file('README.md', readme), file('package.json', pkg)]);

    assert.equal(result.mcpPreview?.type, 'remote');
  });

  it('does not treat a documentation link as an endpoint', () => {
    // Regression: any URL ending in /mcp counted, including a link to the spec,
    // so local servers were offered as remote ones.
    const readme = '# Notes\n\nSee https://modelcontextprotocol.io/docs/mcp for background.';
    const pkg = JSON.stringify({
      bin: { notes: 'dist/index.js' },
      dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' },
    });
    const result = detect.classify([file('README.md', readme), file('package.json', pkg)]);

    assert.equal(result.mcpPreview?.type, 'local');
  });

  it('defaults to local', () => {
    const pkg = JSON.stringify({ dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' } });

    assert.equal(detect.classify([file('package.json', pkg)]).mcpPreview?.type, 'local');
  });
});

describe('classify: combined and empty', () => {
  it('reports both when a repository is a skill and a server', () => {
    const pkg = JSON.stringify({
      name: 'notes-server',
      dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' },
    });
    const result = detect.classify([file('SKILL.md', SKILL_MD), file('package.json', pkg)]);

    assert.equal(result.type, 'both');
    assert.equal(result.confidence, 'strong');
    assert.equal(result.skillPreview?.name, 'pdf-filler');
    assert.equal(result.mcpPreview?.suggestedName, 'notes-server');
  });

  it('takes its confidence from the weaker half', () => {
    // The skill half is certain; the MCP half is a guess. The combined claim is
    // only as good as its weaker part.
    const result = detect.classify(
      [file('SKILL.md', SKILL_MD)],
      'https://github.com/acme/mcp-server-files',
    );

    assert.equal(result.type, 'both');
    assert.equal(result.confidence, 'weak');
  });

  it('reports invalid for an unrecognisable archive', () => {
    const result = detect.classify([file('main.go', 'package main'), file('LICENSE', 'MIT')]);

    assert.equal(result.type, 'invalid');
    assert.equal(result.confidence, null);
    assert.equal(result.skillPreview, undefined);
    assert.equal(result.mcpPreview, undefined);
  });

  it('reports invalid for an empty archive', () => {
    assert.equal(detect.classify([]).type, 'invalid');
  });
});

// ---------------------------------------------------------------------------

describe('detectResource', () => {
  let server: http.Server;
  let origin: string;

  before(async () => {
    server = http.createServer((req, res) => {
      const url = req.url ?? '/';

      if (url === '/skill/SKILL.md') {
        res.writeHead(200, { 'Content-Type': 'text/markdown' }).end(SKILL_MD);
        return;
      }

      if (url === '/server.zip') {
        const zip = new AdmZip();
        zip.addFile('repo-main/SKILL.md', Buffer.from(SKILL_MD, 'utf8'));
        zip.addFile(
          'repo-main/package.json',
          Buffer.from(
            JSON.stringify({
              name: 'notes-server',
              dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' },
            }),
            'utf8',
          ),
        );
        res.writeHead(200, { 'Content-Type': 'application/zip' }).end(zip.toBuffer());
        return;
      }

      if (url === '/plain.txt') {
        res.writeHead(200, { 'Content-Type': 'text/plain' }).end('nothing to see here');
        return;
      }

      res.writeHead(404).end('not found');
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('mock server failed to bind');
    origin = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  });

  it('answers invalid for a URL that 404s', async () => {
    // Regression: every fetch failure arrived as AppError('bad_request'), and
    // the guard re-threw on that code — so a dead link became an HTTP 400 and
    // the documented `invalid` result was unreachable.
    const result = await detect.detectResource(`${origin}/missing`);

    assert.equal(result.type, 'invalid');
    assert.equal(result.confidence, null);
    assert.match(result.reason, /404/);
  });

  it('answers invalid for an unreachable host', async () => {
    const result = await detect.detectResource('http://127.0.0.1:1/whatever');

    assert.equal(result.type, 'invalid');
  });

  it('answers invalid for a reachable file with nothing in it', async () => {
    const result = await detect.detectResource(`${origin}/plain.txt`);

    assert.equal(result.type, 'invalid');
  });

  it('classifies a raw SKILL.md served over http', async () => {
    const result = await detect.detectResource(`${origin}/skill/SKILL.md`);

    assert.equal(result.type, 'skill');
    assert.equal(result.skillPreview?.name, 'pdf-filler');
  });

  it('classifies a zip, stripping the wrapper directory', async () => {
    const result = await detect.detectResource(`${origin}/server.zip`);

    assert.equal(result.type, 'both');
    assert.equal(result.confidence, 'strong');
    assert.equal(result.skillPreview?.name, 'pdf-filler');
    assert.equal(result.mcpPreview?.suggestedName, 'notes-server');
  });

  it('rejects a malformed URL as a bad request', async () => {
    await assert.rejects(
      () => detect.detectResource('not a url'),
      (error: unknown) => (error as { code?: string }).code === 'bad_request',
    );
  });

  it('rejects a non-http scheme as a bad request', async () => {
    // A file:// URL is the one case that must not be answered with `invalid`:
    // it is a client mistake, and reporting it as "nothing found there" would
    // hide that the scheme is the problem.
    await assert.rejects(
      () => detect.detectResource('file:///etc/passwd'),
      (error: unknown) => (error as { code?: string }).code === 'bad_request',
    );
  });
});
