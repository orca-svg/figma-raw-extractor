import type { FigmaQuestionAnswer } from "../types";

type Props = { answer?: FigmaQuestionAnswer };

export function FigmaAnswerCard({ answer }: Props) {
  if (!answer) return null;
  return (
    <section className="figma-answer-card" aria-labelledby="figma-answer-title">
      <div className="answer-heading"><span>CODEX ANSWER</span><h2 id="figma-answer-title">노드 질문 답변</h2><code>{answer.model}</code></div>
      <p className="answer-body">{answer.answer}</p>
      <div className="answer-evidence">
        <strong>근거 {answer.evidence.length}</strong>
        <ul>{answer.evidence.map((evidence, index) => <li key={`${evidence.kind}-${evidence.nodeId ?? evidence.versionId ?? evidence.artifactId ?? evidence.tool ?? index}`}><span>{evidence.kind}</span><code>{evidence.nodeId ?? evidence.versionId ?? evidence.artifactId ?? evidence.tool ?? "근거 참조"}</code>{evidence.detail ? <p>{evidence.detail}</p> : null}</li>)}</ul>
      </div>
      {answer.uncertainties.length ? <div className="answer-uncertainties"><strong>확인할 수 없는 부분</strong><ul>{answer.uncertainties.map((item) => <li key={item}>{item}</li>)}</ul></div> : null}
    </section>
  );
}
