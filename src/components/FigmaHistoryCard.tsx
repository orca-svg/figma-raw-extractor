import type { ExtractionEvent } from "../types";

type Snapshot = { id: string; createdAt: string; label?: string; current?: boolean; user?: { id?: string; name?: string; handle?: string } };
type Change = { versionId: string; nodeId: string; category: string; createdAt: string; actor?: Snapshot["user"] };
type ActorGroup = { actorKey: string; actor?: Snapshot["user"]; changes: Change[] };

function historyFrom(events: ExtractionEvent[]) {
  const versionsEvent = [...events].reverse().find((candidate) => candidate.group === "versions" && candidate.state !== "running");
  const diffEvent = [...events].reverse().find((candidate) => candidate.group === "diff" && candidate.state !== "running");
  if (!versionsEvent && !diffEvent) return undefined;
  const value = diffEvent?.response && typeof diffEvent.response === "object" ? diffEvent.response as Record<string, unknown> : {};
  return {
    snapshots: Array.isArray(versionsEvent?.response) ? versionsEvent.response as Snapshot[] : [],
    changes: Array.isArray(value.changes) ? value.changes as Change[] : [],
    byActor: Array.isArray(value.byActor) ? value.byActor as ActorGroup[] : [],
    unavailableReason: typeof value.unavailableReason === "string" ? value.unavailableReason : versionsEvent?.message,
  };
}

function actorName(user?: Snapshot["user"]) {
  return user?.name ?? user?.handle ?? "작성자 미상";
}

export function FigmaHistoryCard({ events }: { events: ExtractionEvent[] }) {
  const history = historyFrom(events);
  if (!history) return null;
  if (!history.snapshots.length) return history.unavailableReason ? <aside className="history-unavailable"><strong>변경 이력 없음</strong><span>{history.unavailableReason}</span></aside> : null;
  return (
    <section className="figma-history-card" aria-labelledby="figma-history-title">
      <header><div><span>VERSION TRACE</span><h2 id="figma-history-title">최근 변경 순서와 작성자</h2></div><p>버전 간 관찰 결과 · coarse attribution</p></header>
      <div className="version-sequence" aria-label="최근 버전 순서">
        {history.snapshots.map((snapshot, index) => <div key={snapshot.id} className={snapshot.current ? "current" : ""}><span>{String(index + 1).padStart(2, "0")}</span><strong>{snapshot.label || (snapshot.current ? "현재 버전" : snapshot.id)}</strong><small>{actorName(snapshot.user)} · {new Date(snapshot.createdAt).toLocaleString()}</small></div>)}
      </div>
      <div className="history-breakdown">
        <div><strong>변화 {history.changes.length}</strong><ul>{history.changes.slice(-8).map((change, index) => <li key={`${change.versionId}-${change.nodeId}-${change.category}-${index}`}><span>{change.category}</span><code>{change.nodeId}</code><small>{change.versionId}</small></li>)}</ul></div>
        <div><strong>동일 작성자 묶음 {history.byActor.length}</strong><ul>{history.byActor.map((group) => <li key={group.actorKey}><span>{actorName(group.actor)}</span><code>{group.actorKey}</code><small>{group.changes.length} changes</small></li>)}</ul></div>
      </div>
    </section>
  );
}
