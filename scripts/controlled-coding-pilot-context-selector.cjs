#!/usr/bin/env node
"use strict";

function invalidContextSelection(message = "PILOT_DEFINITION_INVALID") {
  throw Object.assign(new Error(message), {
    pilotCode: "PILOT_DEFINITION_INVALID"
  });
}

function canonicalKeys(value, expected) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function validateSelector(selector) {
  if (!selector || typeof selector !== "object" || Array.isArray(selector)) {
    invalidContextSelection();
  }

  if (selector.kind === "symbol") {
    if (
      !canonicalKeys(selector, ["kind", "name"]) ||
      typeof selector.name !== "string" ||
      selector.name.length === 0
    ) invalidContextSelection();
    return;
  }

  if (selector.kind === "anchor") {
    if (
      !canonicalKeys(selector, ["kind", "start", "end"]) ||
      typeof selector.start !== "string" || selector.start.length === 0 ||
      typeof selector.end !== "string" || selector.end.length === 0
    ) invalidContextSelection();
    return;
  }

  if (selector.kind === "lines") {
    if (
      !canonicalKeys(selector, ["kind", "startLine", "endLine"]) ||
      !Number.isSafeInteger(selector.startLine) || selector.startLine < 1 ||
      !Number.isSafeInteger(selector.endLine) ||
      selector.endLine < selector.startLine
    ) invalidContextSelection();
    return;
  }

  invalidContextSelection();
}

function validateContextSelections(contextSelections, options = {}) {
  if (!Array.isArray(contextSelections) || contextSelections.length === 0) {
    invalidContextSelection();
  }

  const requiredPaths = new Set(options.requiredPaths ?? []);
  const allowedReadRoots = new Set(options.allowedReadRoots ?? []);
  const paths = new Set();

  for (const entry of contextSelections) {
    if (
      !canonicalKeys(entry, ["path", "selectors"]) ||
      typeof entry.path !== "string" || entry.path.length === 0 ||
      !Array.isArray(entry.selectors) || entry.selectors.length === 0 ||
      paths.has(entry.path)
    ) invalidContextSelection();

    if (allowedReadRoots.size > 0 && !allowedReadRoots.has(entry.path)) {
      invalidContextSelection();
    }

    paths.add(entry.path);
    entry.selectors.forEach(validateSelector);
  }

  if (
    requiredPaths.size > 0 &&
    (paths.size !== requiredPaths.size ||
      [...requiredPaths].some((path) => !paths.has(path)))
  ) invalidContextSelection();

  return structuredClone(contextSelections);
}

function uniqueIndex(content, needle) {
  const first = content.indexOf(needle);
  if (first < 0 || content.indexOf(needle, first + needle.length) >= 0) {
    invalidContextSelection();
  }
  return first;
}

function lineAtOffset(content, offset) {
  return content.slice(0, offset).split(/\r?\n/).length;
}

function wholeLineRange(content, startOffset, endOffsetExclusive) {
  const startLine = lineAtOffset(content, startOffset);
  const endLine = lineAtOffset(
    content,
    Math.max(startOffset, endOffsetExclusive - 1)
  );
  return { startLine, endLine };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function declarationMatches(content, name) {
  const escaped = escapeRegex(name);
  const pattern = new RegExp(
    `^(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?` +
      `(?:function|class|interface|type|const|let|var)\\s+${escaped}\\b`,
    "gm"
  );
  return [...content.matchAll(pattern)];
}

function scanDeclarationEnd(content, startOffset) {
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let depth = 0;
  let sawBrace = false;

  for (let index = startOffset; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") {
      sawBrace = true;
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (sawBrace && depth === 0) {
        let end = index + 1;
        while (end < content.length && /[ \t]/.test(content[end])) end += 1;
        if (content[end] === ";") end += 1;
        return end;
      }
      continue;
    }
    if (!sawBrace && char === ";") return index + 1;
  }

  invalidContextSelection();
}

function resolveSelector(content, selector, totalLines) {
  if (selector.kind === "lines") {
    if (selector.endLine > totalLines) invalidContextSelection();
    return { startLine: selector.startLine, endLine: selector.endLine };
  }

  if (selector.kind === "anchor") {
    const startOffset = uniqueIndex(content, selector.start);
    const endAnchorOffset = uniqueIndex(content, selector.end);
    if (endAnchorOffset < startOffset) invalidContextSelection();
    return wholeLineRange(
      content,
      startOffset,
      endAnchorOffset + selector.end.length
    );
  }

  if (selector.kind === "symbol") {
    const matches = declarationMatches(content, selector.name);
    if (matches.length !== 1) invalidContextSelection();
    const startOffset = matches[0].index;
    const endOffset = scanDeclarationEnd(content, startOffset);
    return wholeLineRange(content, startOffset, endOffset);
  }

  invalidContextSelection();
}

function mergeRanges(ranges) {
  const sorted = [...ranges].sort((left, right) =>
    left.startLine - right.startLine || left.endLine - right.endLine
  );
  const merged = [];

  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.startLine <= previous.endLine + 1) {
      previous.endLine = Math.max(previous.endLine, range.endLine);
    } else {
      merged.push({ ...range });
    }
  }

  return merged;
}

function resolveContextSelections(workspaceFiles, contextSelections) {
  const selections = validateContextSelections(contextSelections, {
    requiredPaths: workspaceFiles.map((file) => file.path),
    allowedReadRoots: workspaceFiles.map((file) => file.path)
  });
  const byPath = new Map(selections.map((entry) => [entry.path, entry]));

  return workspaceFiles.map((file) => {
    const selection = byPath.get(file.path);
    if (!selection) invalidContextSelection();
    const lines = file.content.split(/\r?\n/);
    const ranges = mergeRanges(selection.selectors.map((selector) =>
      resolveSelector(file.content, selector, lines.length)
    ));

    if (ranges.length === 0) invalidContextSelection();

    return {
      path: file.path,
      sourceContentHash: file.contentHash,
      authority: file.authority,
      relatedSymbols: file.relatedSymbols,
      totalLines: lines.length,
      excerpts: ranges.map(({ startLine, endLine }) => ({
        startLine,
        endLine,
        content: lines.slice(startLine - 1, endLine).join("\n"),
        trustBoundary: "UNTRUSTED_REPOSITORY_DATA"
      }))
    };
  });
}

module.exports = {
  resolveContextSelections,
  validateContextSelections
};
