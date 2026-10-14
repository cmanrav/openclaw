/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { createTestTranscript, stubAnimationFrames } from "../chat-view.test-helpers.ts";
import { saveChatSessionScrollPosition } from "../scroll.ts";
import { renderChatThread } from "./chat-thread.test-support.ts";
import { ChatTranscriptController } from "./chat-transcript-controller.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  mountTestTranscript,
  observedElements,
  resetTranscriptTestDom,
  resizeObservers,
  threadProps,
  TranscriptTestHost,
  type TestContentRow,
  transcriptDomState,
  transcriptRows,
  transcriptSize,
} from "./chat-transcript.test-support.ts";

customElements.define("scroll-restore-test-host", TranscriptTestHost);

function stubMcpAppLifecycle(
  container: ParentNode,
  teardown: () => Promise<void> = () => Promise.resolve(),
) {
  const app = expectDefined(
    container.querySelector<HTMLElement>("mcp-app-view"),
    "mounted MCP app",
  );
  const lifecycle = {
    restartAfterTeardown: vi.fn(),
    teardown: vi.fn(teardown),
  };
  return { app: Object.assign(app, lifecycle), ...lifecycle };
}

function numberedContentRows(length: number): TestContentRow[] {
  return Array.from({ length }, (_, index) => ({
    kind: "content",
    key: `row:${index}`,
    content: html`<div>row ${index}</div>`,
  }));
}

function mcpRangeRows(appContent: unknown): TestContentRow[] {
  return Array.from({ length: 24 }, (_, index) => ({
    kind: "content" as const,
    key: `row:${index}`,
    content: index === 23 ? appContent : html`<div>row ${index}</div>`,
  }));
}

describe("chat transcript controller", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);

  it.each([false, true])("re-observes re-stamped rows (foreign host=%s)", async (foreignHost) => {
    const props = threadProps("pane-measure");
    saveChatSessionScrollPosition(props.paneId, props.sessionKey, {
      scrollTop: 0,
      anchorToEnd: false,
    });
    const transcript = createTestTranscript(props.paneId);
    const chatFace = document.body.appendChild(document.createElement("div"));
    render(renderChatThread(props, transcript), chatFace);
    transcript.hostConnected();
    transcript.hostUpdated();
    await flushDeferredRowPrune();
    const chatScroller = expectDefined(chatFace.querySelector(".chat-thread"), "chat scroller");
    expect(observedElements.has(chatScroller)).toBe(true);
    const chatRows = transcriptRows(chatFace);
    expect(chatRows.length).toBeGreaterThanOrEqual(4);
    for (const row of chatRows) {
      expect(observedElements.has(row)).toBe(true);
    }
    if (foreignHost) {
      render(nothing, chatFace);
      transcript.hostUpdated();
      await flushDeferredRowPrune();
    }
    const dock = document.body.appendChild(document.createElement("div"));
    render(renderChatThread(props, transcript), dock);
    // A foreign Lit host stamps after the pane's last update; attachment must follow the DOM ref.
    if (!foreignHost) {
      transcript.hostUpdated();
    }
    await flushDeferredRowPrune();
    const dockScroller = expectDefined(dock.querySelector(".chat-thread"), "dock scroller");
    expect(observedElements.has(dockScroller)).toBe(true);
    const dockRows = transcriptRows(dock);
    expect(dockRows).toEqual(chatRows);
    for (const row of dockRows) {
      expect(observedElements.has(row)).toBe(true);
    }
    expect(observedElements.has(chatScroller)).toBe(false);
    transcript.hostDisconnected();
  });

  it("measures newly inserted rows after Lit connects them", async () => {
    // Lit invokes ref callbacks while a new row is still detached. Browsers
    // report a zero offsetHeight there, which must not become the row's
    // durable virtual size before the following user bubble is positioned.
    transcriptDomState.detachedRowHeight = 0;
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const props = threadProps("pane-commentary-insert", "agent:main:session-a", [
      { role: "assistant", content: "commentary", timestamp: 1_000 },
      { role: "user", content: "next turn", timestamp: 2_000 },
    ]);

    render(renderChatThread(props, transcript), container);
    transcript.hostConnected();
    transcript.hostUpdated();
    await flushDeferredRowPrune();
    for (const observer of resizeObservers) {
      for (const row of transcriptRows(container)) {
        observer.emitTarget(row, 800, 100);
      }
    }
    render(renderChatThread(props, transcript), container);

    expect(transcriptSize(container)).toBe(200);
  });

  it("reveals committed initial row sizes without waiting for an animation frame", async () => {
    stubAnimationFrames();
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
    const host = new TranscriptTestHost();
    const transcript = new ChatTranscriptController(host, () => "native-measured-tail");
    const rows = numberedContentRows(6);
    host.renderTranscript = () => html`
      <div class="chat-thread">
        ${transcript.renderSession("agent:main:native-measured-tail", (session) => {
          session.setContentReady(true);
          return session.render(
            rows,
            (row) => (row.kind === "content" ? row.content : nothing),
            null,
            false,
          );
        })}
      </div>
    `;
    document.body.append(host);
    await host.settleUpdates();
    const extent = expectDefined(
      host.querySelector<HTMLElement>(".chat-thread-inner"),
      "initial rows",
    );
    expect(transcriptRows(host).every((row) => observedElements.has(row))).toBe(true);
    await Promise.resolve();
    flush();
    await host.settleUpdates();
    expect(extent.style.visibility).toBe("");
    expect(
      transcriptRows(host).every((row) => row.style.containIntrinsicBlockSize === "100px"),
    ).toBe(true);
    expect(host.textContent).toContain("row 5");
    host.remove();
  });

  it("keeps retained MCP rows and the virtual row model atomic through teardown", async () => {
    const teardownPending = createDeferred();
    transcriptDomState.measuredRowHeight = 180;
    const initialRows = [
      { kind: "content" as const, key: "app", content: html`<mcp-app-view></mcp-app-view>` },
      { kind: "content" as const, key: "group:tool", content: html`<div>tool</div>` },
      { kind: "content" as const, key: "group:reply", content: html`<div>reply</div>` },
    ];
    const regroupedRows = [
      { kind: "content" as const, key: "history", content: html`<div>history</div>` },
      {
        kind: "content" as const,
        key: "group:reply",
        content: html`<div>regrouped</div>`,
      },
      { kind: "content" as const, key: "group:next", content: html`<div>next</div>` },
    ];
    const { container, renderRows } = await mountTestTranscript("pane-mcp-rows", initialRows);
    for (const observer of resizeObservers) {
      for (const row of transcriptRows(container)) {
        observer.emitTarget(row, 800, 180);
      }
    }
    renderRows(initialRows);
    expect(transcriptSize(container)).toBe(540);
    stubMcpAppLifecycle(container, () => teardownPending.promise);

    renderRows(regroupedRows);
    const retainedRows = transcriptRows(container);
    expect(retainedRows.map((row) => row.dataset.virtualRowKey)).toEqual([
      "app",
      "group:tool",
      "group:reply",
    ]);

    // Deliver an old-tree resize while teardown keeps that tree connected.
    // Its data-index values must still resolve through the old key model.
    Object.defineProperty(retainedRows[1]!, "offsetHeight", { configurable: true, value: 40 });
    for (const observer of resizeObservers) {
      observer.emitTarget(retainedRows[1]!, 800, 40);
    }
    teardownPending.resolve();
    await teardownPending.promise;
    await Promise.resolve();
    renderRows(regroupedRows);
    await flushDeferredRowPrune();
    renderRows(regroupedRows);

    const committedRows = transcriptRows(container);
    expect(committedRows.map((row) => row.dataset.virtualRowKey)).toEqual([
      "history",
      "group:reply",
      "group:next",
    ]);
    // New rows receive their first sizes; the retained reply must keep its own.
    for (const observer of resizeObservers) {
      for (const row of committedRows) {
        if (row.dataset.virtualRowKey !== "group:reply") {
          observer.emitTarget(row, 800, 180);
        }
      }
    }
    renderRows(regroupedRows);
    // The old tool's 40px delivery must not resize the retained reply key.
    expect(transcriptSize(container)).toBe(540);
  });

  it.each([
    { idleBeforeRelease: false, outsideContact: false },
    { idleBeforeRelease: true, outsideContact: false },
    { idleBeforeRelease: true, outsideContact: true },
  ])(
    "keeps the committed rows and message lookup together while a touch holds a prepend, idle=$idleBeforeRelease, outside contact=$outsideContact",
    async ({ idleBeforeRelease, outsideContact }) => {
      const initial: TestContentRow[] = [
        {
          kind: "content",
          key: "retained-row",
          content: html`<div class="chat-bubble" data-message-id="retained">retained</div>`,
        },
      ];
      const next: TestContentRow[] = [
        {
          kind: "content",
          key: "expanded-row",
          content: html`<div class="chat-bubble" data-message-id="older">older</div>
            <div class="chat-bubble" data-message-id="retained">retained</div>`,
        },
      ];
      const { container, session, transcript, renderRows } = await mountTestTranscript(
        "touch-map",
        initial,
      );
      try {
        session.syncMessageRows(
          new Map([["retained", "retained-row"]]),
          new Map([["retained", "retained-row"]]),
        );
        renderRows(initial);
        const bubble = expectDefined(container.querySelector(".chat-bubble"), "retained bubble");
        const contact = (identifier: number, target: EventTarget): Touch => ({
          identifier,
          target,
          clientX: 0,
          clientY: 100,
          pageX: 0,
          pageY: 100,
          screenX: 0,
          screenY: 100,
          radiusX: 1,
          radiusY: 1,
          rotationAngle: 0,
          force: 1,
        });
        const owned = contact(1, bubble);
        const remaining = outsideContact ? [contact(2, document.body)] : [];
        bubble.dispatchEvent(
          new TouchEvent("touchstart", {
            touches: [...remaining, owned],
            targetTouches: [owned],
            changedTouches: [owned],
            bubbles: true,
          }),
        );
        if (idleBeforeRelease) {
          // The finger can remain down after native offset notifications settle.
          vi.useFakeTimers();
          container.scrollTop = 10;
          container.dispatchEvent(new Event("scroll"));
          await vi.advanceTimersByTimeAsync(200);
        }
        session.syncMessageRows(
          new Map([
            ["older", "expanded-row"],
            ["retained", "expanded-row"],
          ]),
          new Map([
            ["older", "expanded-row"],
            ["retained", "expanded-row"],
          ]),
        );
        renderRows(next);
        expect(transcriptRows(container).map((row) => row.dataset.virtualRowKey)).toEqual([
          "retained-row",
        ]);
        expect(container.textContent).not.toContain("older");
        expect(session.activeMessageId(["retained"])).toBe("retained");
        expect(session.activeMessageId(["older"])).toBeNull();
        bubble.dispatchEvent(
          new TouchEvent("touchend", {
            touches: remaining,
            targetTouches: [],
            changedTouches: [owned],
            bubbles: true,
          }),
        );
        renderRows(next);
        expect(transcriptRows(container).map((row) => row.dataset.virtualRowKey)).toEqual([
          "expanded-row",
        ]);
        expect(container.textContent).toContain("older");
        expect(session.activeMessageId(["retained"])).toBe("retained");
        expect(session.activeMessageId(["older"])).toBe("older");
      } finally {
        transcript.hostDisconnected();
        if (idleBeforeRelease) {
          vi.useRealTimers();
        }
      }
    },
  );

  it.each(["append", "reorder", "focused reorder"] as const)(
    "retains only MCP rows in the next rendered range (%s)",
    async (change) => {
      const focused = change === "focused reorder";
      const initialRows =
        change === "append"
          ? [
              {
                kind: "content" as const,
                key: "app",
                content: html`<mcp-app-view></mcp-app-view>`,
              },
              { kind: "content" as const, key: "reply", content: html`<div>reply</div>` },
            ]
          : mcpRangeRows(
              focused
                ? html`<mcp-app-view
                    ><iframe title="Retained application"></iframe
                    ><button>focus app</button></mcp-app-view
                  >`
                : html`<mcp-app-view></mcp-app-view>`,
            );
      const { container, renderRows } = await mountTestTranscript("pane-mcp-range", initialRows);
      const { app, teardown } = stubMcpAppLifecycle(container);
      const frame = app.querySelector("iframe");
      const rowParent = app.parentElement?.parentElement;
      if (focused) {
        expectDefined(frame, "retained application frame");
        expectDefined(rowParent, "retained row parent");
        expectDefined(app.querySelector("button"), "MCP app focus target").dispatchEvent(
          new FocusEvent("focusin", { bubbles: true }),
        );
      }
      renderRows(
        change === "append"
          ? [...initialRows, { kind: "content", key: "next", content: html`<div>next</div>` }]
          : [initialRows.at(-1)!, ...initialRows.slice(0, -1)],
      );
      if (change === "reorder") {
        expect(teardown).toHaveBeenCalledOnce();
        expect(app.isConnected).toBe(true);
      } else {
        expect(teardown).not.toHaveBeenCalled();
        expect(container.querySelector("mcp-app-view")).toBe(app);
        if (focused) {
          expect(app.isConnected).toBe(true);
          expect(app.querySelector("iframe")).toBe(frame);
          expect(app.parentElement?.parentElement).toBe(rowParent);
        }
      }
    },
  );

  it("reconciles an implicit end anchor when committed content has no scroll range", async () => {
    const flushFrames = stubAnimationFrames();
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const messages = Array.from({ length: 18 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${index}`,
      timestamp: index + 1,
    }));
    const props = threadProps("pane-underfill-anchor", "agent:main:underfill", messages);
    render(renderChatThread(props, transcript), container);
    await Promise.resolve();
    flush();
    const scrollElement = container.querySelector<HTMLElement>(".chat-thread");
    expect(scrollElement).not.toBeNull();
    Object.defineProperties(scrollElement, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 600 },
    });

    transcript.hostConnected();
    transcript.scrollToEnd({ source: "auto" });
    transcript.hostUpdated();
    await Promise.resolve();
    flushFrames();
    render(renderChatThread(props, transcript), container);
    await Promise.resolve();
    flush();
    render(renderChatThread(props, transcript), container);
    await Promise.resolve();
    flush();
    expect(transcriptRows(container)[0]?.dataset.index).toBe("0");
    expect(container.textContent).toContain("message 0");
  });
});
