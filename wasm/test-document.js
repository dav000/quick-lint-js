// Copyright (C) 2020  Matthew "strager" Glazar
// See end of file for extended copyright information.

"use strict";

let assert = require("assert");
let qljs = require("./quick-lint-js.js");

let {
  DiagnosticSeverity,
  DocumentLinter,
  DocumentLinterDisposed,
  DocumentProcessManager,
  LintingCrashed,
  ProcessCrashed,
  createProcessFactoryAsync,
} = qljs;

describe("DocumentLinter", () => {
  let toDisposeAfterTest = [];
  function disposeAfterTest(disposable) {
    toDisposeAfterTest.push(disposable);
    return disposable;
  }
  afterEach(async () => {
    let allToDispose = toDisposeAfterTest.splice(0, toDisposeAfterTest.length);
    for (let toDispose of allToDispose) {
      await toDispose.disposeAsync();
    }
  });

  let originalMaybeInjectFault = qljs.maybeInjectFault;
  afterEach(() => {
    qljs.maybeInjectFault = originalMaybeInjectFault;
  });

  it("diagnostic severity", async () => {
    let document = new MockDocument("let x;let x;\nundeclaredVariable");
    let linter = disposeAfterTest(
      new DocumentLinter(document, new DocumentProcessManager())
    );
    await linter.editorChangedVisibilityAsync();

    assert.deepStrictEqual(
      document.diagnostics.map((diag) => ({
        message: diag.message,
        severity: diag.severity,
      })),
      [
        {
          message: "redeclaration of variable: x",
          severity: DiagnosticSeverity.ERROR,
        },
        {
          message: "use of undeclared variable: undeclaredVariable",
          severity: DiagnosticSeverity.WARNING,
        },
      ]
    );
  });

  it("opening editor lints", async () => {
    let document = new MockDocument("let x;let x;");
    let linter = disposeAfterTest(
      new DocumentLinter(document, new DocumentProcessManager())
    );

    await linter.editorChangedVisibilityAsync();

    assert.deepStrictEqual(document.getDiagnosticMessages(), [
      "redeclaration of variable: x",
    ]);
  });

  it("applying change to unopened editor lints", async () => {
    let document = new MockDocument("let x;");
    let linter = disposeAfterTest(
      new DocumentLinter(document, new DocumentProcessManager())
    );
    assert.deepStrictEqual(document.diagnostics, []);

    let changes = [
      {
        range: {
          start: { line: 0, character: document.text.length },
          end: { line: 0, character: document.text.length },
        },
        text: "let x;",
      },
    ];
    document.text += changes[0].text;
    await linter.textChangedAsync(changes);

    assert.deepStrictEqual(document.getDiagnosticMessages(), [
      "redeclaration of variable: x",
    ]);
  });

  it("applying multiple changes ignores document text", async () => {
    // NOTE(strager): This test is testing an implementation detail. Parsing
    // based on changes should be preferred; document.getText() should only be
    // called as a last resort.

    let document = new MockDocument("let x;");
    let linter = disposeAfterTest(
      new DocumentLinter(document, new DocumentProcessManager())
    );
    await linter.editorChangedVisibilityAsync();
    assert.deepStrictEqual(document.diagnostics, []);

    let effectiveDocumentText = document.text;
    for (let charactersToType of ["let", " x;", " // done"]) {
      let changes = [
        {
          range: {
            start: { line: 0, character: effectiveDocumentText.length },
            end: { line: 0, character: effectiveDocumentText.length },
          },
          text: charactersToType,
        },
      ];
      // N.B. Do not update document.text. linter should not inspect
      // document.text; it should only use the given changes.
      effectiveDocumentText += charactersToType;
      await linter.textChangedAsync(changes);
    }

    assert.deepStrictEqual(document.getDiagnosticMessages(), [
      "redeclaration of variable: x",
    ]);
  });

  it("dispose unused linter", async () => {
    let document = new MockDocument("let x;");
    let linter = new DocumentLinter(document, new DocumentProcessManager());
    // Should not throw.
    await linter.disposeAsync();
  });

  it("dispose initializing linter", async () => {
    let document = new MockDocument("hello.js", "let x;");
    let linter = new DocumentLinter(document, new DocumentProcessManager());
    let promise = linter.editorChangedVisibilityAsync();

    // Should not throw.
    await linter.disposeAsync();
    await assert.rejects(promise, DocumentLinterDisposed);
  });

  it("concurrent edits are applied in order of calls", async () => {
    let document = new MockDocument("let x;");
    let linter = disposeAfterTest(
      new DocumentLinter(document, new DocumentProcessManager())
    );
    await linter.editorChangedVisibilityAsync();

    let promises = [];
    for (let characterToType of "let x; // done") {
      let changes = [
        {
          range: {
            start: { line: 0, character: document.text.length },
            end: { line: 0, character: document.text.length },
          },
          text: characterToType,
        },
      ];
      document.text += characterToType;
      promises.push(linter.textChangedAsync(changes));
    }
    await Promise.all(promises);

    assert.deepStrictEqual(
      document.diagnostics.map((diag) => ({
        start: diag.startCharacter,
        end: diag.endCharacter,
      })),
      [{ start: "let x;let ".length, end: "let x;let x".length }]
    );
  });

  it("open editor and make changes, with exhaustive fault injection", async () => {
    let xRedeclarationDiagnostic = {
      code: "E034",
      message: "redeclaration of variable: x",
      severity: DiagnosticSeverity.ERROR,
      startLine: 0,
      startCharacter: "let x;let ".length,
      endLine: 0,
      endCharacter: "let x;let x".length,
    };
    let yRedeclarationDiagnostic = {
      code: "E034",
      message: "redeclaration of variable: y",
      severity: DiagnosticSeverity.ERROR,
      startLine: 1,
      startCharacter: "let y;let ".length,
      endLine: 1,
      endCharacter: "let y;let y".length,
    };

    let coinFlips;
    let rng = new ExhaustiveRNG();
    let crashedProcesses = new Set();
    qljs.maybeInjectFault = (process, functionName) => {
      assert.ok(
        !crashedProcesses.has(process),
        "Should not use previously-crashed process"
      );
      let shouldCrash = rng.nextCoinFlip();
      coinFlips.push(shouldCrash);
      if (shouldCrash) {
        crashedProcesses.add(process);
        throw new ProcessCrashed("(injected fault)");
      }
    };

    while (!rng.isDone()) {
      coinFlips = [];
      let linter = null;
      try {
        let document = new MockDocument("let x;let x;\n");
        linter = new DocumentLinter(document, new DocumentProcessManager());

        let crashedOpeningEditor = await didLintingCrashAsync(async () => {
          await linter.editorChangedVisibilityAsync();
        });
        if (crashedOpeningEditor) {
          // Linter crashed before any linting could have happened.
          // Therefore, no diagnostics should appear.
          assert.deepStrictEqual(document.diagnostics, []);
        } else {
          let crashedChangingText = await didLintingCrashAsync(async () => {
            document.text = "let x;let x;\nlet y;let y;";
            await linter.textChangedAsync([
              {
                range: {
                  start: { line: 1, character: 0 },
                  end: { line: 1, character: 0 },
                },
                text: "let y;let y;",
              },
            ]);
          });
          if (crashedChangingText) {
            // Linter crashed after linting happened, but before linting the
            // changes could have happened. Therefore, diagnostics should
            // appear for the old version of the document.
            assert.deepStrictEqual(document.diagnostics, [
              xRedeclarationDiagnostic,
            ]);
          } else {
            // Crashes might have happened, but DocumentLinter should have
            // recovered.
            assert.deepStrictEqual(document.diagnostics, [
              xRedeclarationDiagnostic,
              yRedeclarationDiagnostic,
            ]);
          }
        }
      } finally {
        if (linter !== null) {
          await linter.disposeAsync();
        }
      }

      console.log(`coinFlips: ${coinFlips}`);
      rng.lap();

      crashedProcesses.clear(); // Avoid out-of-memory errors.
    }
  }, /*timeout=*/ 60_000);

  it("open editor for multiple documents, with exhaustive fault injection", async () => {
    let coinFlips;
    let rng = new ExhaustiveRNG();
    let crashedProcesses = new Set();
    qljs.maybeInjectFault = (process, functionName) => {
      assert.ok(
        !crashedProcesses.has(process),
        "Should not use previously-crashed process"
      );
      let shouldCrash = rng.nextCoinFlip();
      coinFlips.push(shouldCrash);
      if (shouldCrash) {
        crashedProcesses.add(process);
        throw new ProcessCrashed("(injected fault)");
      }
    };

    while (!rng.isDone()) {
      coinFlips = [];
      let linter1 = null;
      let linter2 = null;
      try {
        let documentProcessManager = new DocumentProcessManager();
        let document1 = new MockDocument("let x1;let x1;\n");
        linter1 = new DocumentLinter(document1, documentProcessManager);
        let document2 = new MockDocument("let x2;let x2;\n");
        linter2 = new DocumentLinter(document2, documentProcessManager);

        await Promise.all([
          openAndCheckDocumentAsync({
            document: document1,
            linter: linter1,
            expectedDiagnosticMessages: ["redeclaration of variable: x1"],
          }),

          openAndCheckDocumentAsync({
            document: document2,
            linter: linter2,
            expectedDiagnosticMessages: ["redeclaration of variable: x2"],
          }),
        ]);
      } finally {
        if (linter2 !== null) {
          await linter2.disposeAsync();
        }
        if (linter1 !== null) {
          await linter1.disposeAsync();
        }
      }

      console.log(`coinFlips: ${coinFlips}`);
      rng.lap();

      crashedProcesses.clear(); // Avoid out-of-memory errors.
    }

    async function openAndCheckDocumentAsync({
      document,
      linter,
      expectedDiagnosticMessages,
    }) {
      let crashedOpeningEditor = await didLintingCrashAsync(async () => {
        await linter.editorChangedVisibilityAsync();
      });
      if (crashedOpeningEditor) {
        // Linter crashed before any linting could have happened.
        // Therefore, no diagnostics should appear.
        assert.deepStrictEqual(document.diagnostics, []);
      } else {
        assert.deepStrictEqual(
          document.getDiagnosticMessages(),
          expectedDiagnosticMessages
        );
      }
    }
  }, /*timeout=*/ 60_000);

  it("edit multiple documents, with exhaustive fault injection", async () => {
    let coinFlips;
    let rng = new ExhaustiveRNG();
    let crashedProcesses = new Set();
    function maybeInjectFaultWithExhaustiveRNG(process, functionName) {
      assert.ok(
        !crashedProcesses.has(process),
        "Should not use previously-crashed process"
      );
      let shouldCrash = rng.nextCoinFlip();
      coinFlips.push(shouldCrash);
      if (shouldCrash) {
        crashedProcesses.add(process);
        throw new ProcessCrashed("(injected fault)");
      }
    }
    async function maybeDelayAsync() {
      let shouldDelay = rng.nextCoinFlip();
      coinFlips.push(shouldDelay);
      if (shouldDelay) {
        await null;
      }
    }

    while (!rng.isDone()) {
      coinFlips = [];
      let linter1 = null;
      let linter2 = null;
      try {
        let documentProcessManager = new DocumentProcessManager();

        let document1 = new MockDocument("let x1;let x1;\n");
        linter1 = new DocumentLinter(document1, documentProcessManager);
        await linter1.editorChangedVisibilityAsync();

        let document2 = new MockDocument("let x2;let x2;\n");
        linter2 = new DocumentLinter(document2, documentProcessManager);
        await linter2.editorChangedVisibilityAsync();

        qljs.maybeInjectFault = maybeInjectFaultWithExhaustiveRNG;

        await Promise.all([
          changeAndCheckDocumentAsync({
            document: document1,
            linter: linter1,
            unchangedDiagnosticMessages: ["redeclaration of variable: x1"],
            changedDiagnosticMessages: [
              "redeclaration of variable: x1",
              "redeclaration of variable: y1",
            ],
            changedText: "let x1;let x1;\nlet y1;let y1;",
            changes: [
              {
                range: {
                  start: { line: 1, character: 0 },
                  end: { line: 1, character: 0 },
                },
                text: "let y1;let y1;",
              },
            ],
          }),

          changeAndCheckDocumentAsync({
            document: document2,
            linter: linter2,
            unchangedDiagnosticMessages: ["redeclaration of variable: x2"],
            changedDiagnosticMessages: [
              "redeclaration of variable: x2",
              "redeclaration of variable: y2",
            ],
            changedText: "let x2;let x2;\nlet y2;let y2;",
            changes: [
              {
                range: {
                  start: { line: 1, character: 0 },
                  end: { line: 1, character: 0 },
                },
                text: "let y2;let y2;",
              },
            ],
          }),
        ]);
      } finally {
        if (linter2 !== null) {
          await linter2.disposeAsync();
        }
        if (linter1 !== null) {
          await linter1.disposeAsync();
        }
      }

      console.log(`coinFlips: ${coinFlips}`);
      rng.lap();
      qljs.maybeInjectFault = originalMaybeInjectFault;

      crashedProcesses.clear(); // Avoid out-of-memory errors.
    }

    async function changeAndCheckDocumentAsync({
      document,
      linter,
      unchangedDiagnosticMessages,
      changedDiagnosticMessages,
      changedText,
      changes,
    }) {
      let crashedChangingText = await didLintingCrashAsync(async () => {
        document.text = changedText;
        await linter.textChangedAsync(changes);
      });
      if (crashedChangingText) {
        // Linter crashed after linting happened, but before linting the
        // changes could have happened. Therefore, diagnostics should
        // appear for the old version of the document.
        assert.deepStrictEqual(
          document.getDiagnosticMessages(),
          unchangedDiagnosticMessages
        );
      } else {
        // Crashes might have happened, but DocumentLinter should have
        // recovered.
        assert.deepStrictEqual(
          document.getDiagnosticMessages(),
          changedDiagnosticMessages
        );
      }
    }
  }, /*timeout=*/ 60_000);

  it("concurrent edits are applied in order of calls, with exhaustive fault injection", async () => {
    let coinFlips;
    let rng = new ExhaustiveRNG();
    let crashedProcesses = new Set();
    function maybeInjectFaultWithExhaustiveRNG(process, functionName) {
      assert.ok(
        !crashedProcesses.has(process),
        "Should not use previously-crashed process"
      );
      let shouldCrash = rng.nextCoinFlip();
      coinFlips.push(shouldCrash);
      if (shouldCrash) {
        crashedProcesses.add(process);
        throw new qljs.ProcessCrashed("(injected fault)");
      }
    }

    while (!rng.isDone()) {
      coinFlips = [];
      let linter;
      try {
        let document = new MockDocument("const x = 10;");
        linter = new DocumentLinter(document, new DocumentProcessManager());
        let shouldOpenEditorBeforeChanges = rng.nextCoinFlip();
        if (shouldOpenEditorBeforeChanges) {
          await linter.editorChangedVisibilityAsync();
        }

        qljs.maybeInjectFault = maybeInjectFaultWithExhaustiveRNG;
        let promises = [];
        for (let charactersToType of ["const ", "x = 10;"]) {
          let changes = [
            {
              range: {
                start: { line: 0, character: document.text.length },
                end: { line: 0, character: document.text.length },
              },
              text: charactersToType,
            },
          ];
          document.text += charactersToType;
          promises.push(linter.textChangedAsync(changes));
        }

        let textChangedResults = await Promise.allSettled(promises);
        let firstChangeFailed = textChangedResults[0].status !== "fulfilled";
        let lastChangeFailed = textChangedResults[1].status !== "fulfilled";

        if (firstChangeFailed && lastChangeFailed) {
          // No changes were applied. The linted document was "const x = 10;".
          assert.deepStrictEqual(document.getDiagnosticMessages(), []);
        } else if (!firstChangeFailed && lastChangeFailed) {
          // Partial changes were applied. The linted document was either
          // "const x = 10;const " (if the first change finished before the second
          // change started) or "const x = 10; const x = 10;" (if the second change failed
          // before the first change started).
          let messages = document.getDiagnosticMessages();
          assert.strictEqual(messages.length, 1, messages);
          assert.ok(
            messages[0] === "let with no bindings" ||
              messages[0] === "const with no bindings" ||
              messages[0] === "var with no bindings" ||
              messages[0] === "redeclaration of variable: x",
            messages
          );
        } else {
          // Because the last call to textChangedAsync succeeded, all changes
          // were applied. The linted document was "const x = 10;const x = 10;".
          assert.deepStrictEqual(document.getDiagnosticMessages(), [
            "redeclaration of variable: x",
          ]);
        }
      } finally {
        if (linter !== null) {
          await linter.disposeAsync();
        }
      }

      console.log(`coinFlips: ${coinFlips}`);
      rng.lap();
      qljs.maybeInjectFault = originalMaybeInjectFault;

      crashedProcesses.clear(); // Avoid out-of-memory errors.
    }
  }, /*timeout=*/ 60_000);

  it("multiple documents with shared process manager lint independently", async () => {
    let documentProcessManager = new DocumentProcessManager();
    let document1 = new MockDocument("let x;let x;");
    let linter1 = disposeAfterTest(
      new DocumentLinter(document1, documentProcessManager)
    );
    let document2 = new MockDocument("let y;let y;");
    let linter2 = disposeAfterTest(
      new DocumentLinter(document2, documentProcessManager)
    );

    await linter1.editorChangedVisibilityAsync();
    assert.deepStrictEqual(document1.getDiagnosticMessages(), [
      "redeclaration of variable: x",
    ]);

    await linter2.editorChangedVisibilityAsync();
    assert.deepStrictEqual(document1.getDiagnosticMessages(), [
      "redeclaration of variable: x",
    ]);
    assert.deepStrictEqual(document2.getDiagnosticMessages(), [
      "redeclaration of variable: y",
    ]);

    document1.text = "let x;let x2;";
    await linter1.textChangedAsync([
      {
        range: {
          start: { line: 0, character: "let x;let x".length },
          end: { line: 0, character: "let x;let x".length },
        },
        text: "2",
      },
    ]);
    assert.deepStrictEqual(document1.getDiagnosticMessages(), []);
    assert.deepStrictEqual(document2.getDiagnosticMessages(), [
      "redeclaration of variable: y",
    ]);

    document2.text = "let z;let z;";
    await linter2.textChangedAsync([
      {
        range: {
          start: { line: 0, character: "let ".length },
          end: { line: 0, character: "let y".length },
        },
        text: "z",
      },
      {
        range: {
          start: { line: 0, character: "let z;let ".length },
          end: { line: 0, character: "let z;let y".length },
        },
        text: "z",
      },
    ]);
    assert.deepStrictEqual(document1.getDiagnosticMessages(), []);
    assert.deepStrictEqual(document2.getDiagnosticMessages(), [
      "redeclaration of variable: z",
    ]);

    assert.strictEqual(documentProcessManager.numberOfProcessesEverCreated, 1);
  });

  it("crashing document does not prevent other document from linting successfully", async () => {
    let documentProcessManager = new DocumentProcessManager();

    let document1 = new MockDocument("let x; let x;");
    let linter1 = disposeAfterTest(
      new DocumentLinter(document1, documentProcessManager)
    );

    let document2 = new MockDocument("let y; let y;");
    let linter2 = disposeAfterTest(
      new DocumentLinter(document2, documentProcessManager)
    );

    qljs.maybeInjectFault = (_process, functionName) => {
      if (functionName === "qljs_vscode_lint") {
        throw new ProcessCrashed("(injected fault)");
      }
    };
    await assert.rejects(async () => {
      await linter1.editorChangedVisibilityAsync();
    });

    qljs.maybeInjectFault = originalMaybeInjectFault;
    await linter2.editorChangedVisibilityAsync();
    assert.deepStrictEqual(document2.getDiagnosticMessages(), [
      "redeclaration of variable: y",
    ]);
  });

  it("untouched documents with crashed process do not leak memory", async () => {
    let numberOfDocuments = 200;
    let sourceLength = 100_000;
    let source = new Array(sourceLength + 1).join(" ");

    let documentProcessManager = new DocumentProcessManager();
    let linters = [];
    for (let i = 0; i < numberOfDocuments; ++i) {
      let document = new MockDocument(source);
      crashProcessOnNextLint();
      let linter = disposeAfterTest(
        new DocumentLinter(document, documentProcessManager)
      );
      linters.push(linter);
      await linter.editorChangedVisibilityAsync();
    }

    function crashProcessOnNextLint() {
      qljs.maybeInjectFault = (_process, functionName) => {
        if (functionName === "qljs_vscode_lint") {
          qljs.maybeInjectFault = originalMaybeInjectFault;
          throw new ProcessCrashed("(injected fault)");
        }
      };
    }
  }, /*timeout=*/ 30_000);
});

describe("ExhaustiveRNG", () => {
  it("exhaust with no calls", () => {
    let rng = new ExhaustiveRNG();
    rng.lap();
    assert.ok(rng.isDone());
  });

  it("coin flip has two laps", () => {
    let rng = new ExhaustiveRNG();
    rng.nextCoinFlip();
    rng.lap();
    assert.ok(!rng.isDone());
    rng.nextCoinFlip();
    rng.lap();
    assert.ok(rng.isDone());
  });

  it("coin flip returns false then true", () => {
    let rng = new ExhaustiveRNG();
    assert.strictEqual(
      rng.nextCoinFlip(),
      false,
      "first coin flip should be false"
    );
    rng.lap();
    assert.strictEqual(
      rng.nextCoinFlip(),
      true,
      "second coin flip should be true"
    );
  });

  it("coin flip and maybe another coin flip (if true) per lap", () => {
    let rng = new ExhaustiveRNG();

    assert.strictEqual(rng.nextCoinFlip(), false);
    rng.lap();

    assert.strictEqual(rng.nextCoinFlip(), true);
    assert.strictEqual(rng.nextCoinFlip(), false);
    rng.lap();

    assert.strictEqual(rng.nextCoinFlip(), true);
    assert.strictEqual(rng.nextCoinFlip(), true);
    rng.lap();

    assert.ok(rng.isDone());
  });

  it("coin flip and maybe another coin flip (if false) per lap", () => {
    let rng = new ExhaustiveRNG();

    assert.strictEqual(rng.nextCoinFlip(), false);
    assert.strictEqual(rng.nextCoinFlip(), false);
    rng.lap();

    assert.strictEqual(rng.nextCoinFlip(), false);
    assert.strictEqual(rng.nextCoinFlip(), true);
    rng.lap();

    assert.strictEqual(rng.nextCoinFlip(), true);
    rng.lap();

    assert.ok(rng.isDone());
  });

  it("exhaust with three nextCoinFlip calls per lap", () => {
    let expectedOutcomesPerLap = [
      [false, false, false],
      [false, false, true],
      [false, true, false],
      [false, true, true],
      [true, false, false],
      [true, false, true],
      [true, true, false],
      [true, true, true],
    ];
    let expectedLaps = expectedOutcomesPerLap.length;
    let rng = new ExhaustiveRNG();
    let i = 0;
    while (i < expectedLaps) {
      let actual0 = rng.nextCoinFlip();
      let actual1 = rng.nextCoinFlip();
      let actual2 = rng.nextCoinFlip();
      let iString = i.toString();
      let expected = expectedOutcomesPerLap[i];
      assert.deepStrictEqual(
        [actual0, actual1, actual2],
        expected,
        `nextCoinFlip-s of lap ${iString}`
      );
      rng.lap();
      i += 1;
      if (rng.isDone()) {
        break;
      }
    }
    assert.strictEqual(i, expectedLaps, "number of laps");
    assert.ok(
      rng.isDone(),
      `rng should be done after ${expectedLaps.toString()} laps`
    );
  });
});

class MockDocument {
  constructor(text) {
    this.text = text;
    this.diagnostics = [];
  }

  getText() {
    return this.text;
  }

  setDiagnostics(diagnostics) {
    this.diagnostics = diagnostics;
  }

  removeDiagnostics() {
    this.diagnostics = [];
  }

  getDiagnosticMessages() {
    return this.diagnostics.map((diag) => diag.message);
  }
}

async function didLintingCrashAsync(callback) {
  try {
    await callback();
    return false;
  } catch (e) {
    if (e instanceof LintingCrashed) {
      return true;
    } else {
      throw e;
    }
  }
}

class ExhaustiveRNG {
  constructor() {
    this._counterIndex = 0;
    this._counters = [];
    this._done = false;
  }

  // Returns true or false.
  nextCoinFlip() {
    if (this._counterIndex >= this._counters.length) {
      this._counters.push(false);
    }
    let result = this._counters[this._counterIndex];
    this._counterIndex += 1;
    return result;
  }

  isDone() {
    return this._done;
  }

  lap() {
    // Update this._counters from right to left.
    let i = this._counterIndex;
    for (;;) {
      if (i === 0) {
        this._done = true;
        break;
      }
      i -= 1;
      if (this._counters[i]) {
        this._counters[i] = false; // Clear for next lap.
      } else {
        this._counters[i] = true;
        break;
      }
    }

    this._counterIndex = 0;
  }
}

// quick-lint-js finds bugs in JavaScript programs.
// Copyright (C) 2020  Matthew "strager" Glazar
//
// This file is part of quick-lint-js.
//
// quick-lint-js is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// quick-lint-js is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with quick-lint-js.  If not, see <https://www.gnu.org/licenses/>.
