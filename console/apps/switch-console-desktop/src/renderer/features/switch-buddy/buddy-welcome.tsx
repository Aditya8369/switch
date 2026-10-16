import { BuddyAvatar } from './buddy-avatar';

/**
 * switch-buddy's opening lines while it does not exist yet: the start of the
 * message it posts once created, drawn as a message from it would be. The tips
 * that follow in the real one name the agent and wait for it.
 */
export function BuddyWelcome({
  firstName,
  agentName,
}: {
  firstName: string | null;
  agentName: string;
}) {
  return (
    <div className="flex gap-3 py-2" data-testid="buddy-welcome">
      <BuddyAvatar size={28} shape="round" className="mt-0.5" />
      <div className="min-w-0 space-y-3 text-sm text-foreground">
        <p className="font-semibold">{agentName}</p>
        <p>
          Hi{firstName ? ` ${firstName}` : ''}, I’m <strong>{agentName}</strong>, your assistant for
          everything Switch. 👋
          <br />
          Switch brings your team to work with your agents, and I’m the first one.
        </p>
        <div>
          <p>I can help you:</p>
          <ul className="mt-1 space-y-0.5">
            <li>🤖 Create agents</li>
            <li>🏠 Make rooms</li>
            <li>💬 Answer anything about Switch</li>
            <li>🧑‍💻 Any task, from researching a topic to writing a document</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
