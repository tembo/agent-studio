import {
  highlightAgentSpec,
  type AgentSpecHighlightKind,
} from "@/lib/agent-spec-highlight";

const tokenClasses: Partial<Record<AgentSpecHighlightKind, string>> = {
  key: "text-foreground-category-blue font-semibold",
  string: "text-foreground-category-green",
  number: "text-foreground-category-purple",
  literal: "text-foreground-category-orange",
  comment: "text-foreground-muted",
  punctuation: "text-foreground-weak",
};

export function HighlightedSpec({
  source,
  language,
}: {
  source: string;
  language: "yaml" | "json";
}) {
  const tokens = highlightAgentSpec(source, language);
  return (
    <pre className="bg-surface border-border text-foreground overflow-x-auto rounded-lg border p-4 font-mono text-sm leading-5">
      <code>
        {tokens.map((token, index) => {
          const className = tokenClasses[token.kind];
          return className ? (
            <span key={index} className={className}>
              {token.text}
            </span>
          ) : (
            token.text
          );
        })}
      </code>
    </pre>
  );
}

export function countSourceLines(source: string): number {
  const content = source.trimEnd();
  return content ? content.split(/\r\n|\r|\n/).length : 0;
}
