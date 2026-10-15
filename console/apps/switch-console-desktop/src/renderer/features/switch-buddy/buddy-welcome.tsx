import { BuddyAvatar } from './buddy-avatar';
import { BUDDY_DISPLAY_NAME } from './buddy-identity';

/**
 * The first thing the buddy's chat says: who it is, what it can do, and two
 * tips. Written here rather than generated, so it is there the moment the
 * chat opens — before the buddy has a provider to run on, or has started.
 *
 * It is the app's message, not one the buddy sent, and says so beside the
 * name. The tips name the agent, so they wait until it exists.
 */
export function BuddyWelcome({
  firstName,
  agentName,
}: {
  firstName: string | null;
  agentName: string | null;
}) {
  return (
    <div className="flex gap-3 py-4" data-testid="buddy-welcome">
      <BuddyAvatar size={28} shape="round" className="mt-0.5" />
      <div className="min-w-0 space-y-3 text-sm text-foreground">
        <p className="flex items-baseline gap-1.5">
          <span className="font-semibold">{BUDDY_DISPLAY_NAME}</span>
          <span className="text-xs text-foreground-muted">· APP</span>
        </p>
        <p>
          Hi{firstName ? ` ${firstName}` : ''}, I’m{' '}
          {agentName ? <strong>{agentName}</strong> : 'switch-buddy'}, your assistant for everything
          Switch. 👋
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
        {agentName && (
          <div className="space-y-2">
            <p>Some tips:</p>
            <div>
              <p className="font-semibold">👫 If you want your team to talk to me</p>
              <ul className="ml-4 list-disc">
                <li>In my Settings tab, set “Who can talk to this agent” to “Anyone”.</li>
                <li>Then invite your team members to the channel I’m in.</li>
              </ul>
            </div>
            <div>
              <p className="font-semibold">➕ If you want to add me to another channel</p>
              <ul className="ml-4 list-disc">
                <li>Go to the channel where you want me.</li>
                <li>
                  Type <code>/invite-agent @{agentName}</code>
                </li>
              </ul>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
