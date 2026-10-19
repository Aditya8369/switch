/**
 * One address in, a server's two origins out.
 *
 * A person connecting a Switch server types one address, which may be the
 * dashboard's or the agent bridge's. Console works out both from it: first by
 * asking the server (`GET /gateway/discovery`), then by checking whether the
 * agent bridge answers at the typed address (`/health`), and only then by
 * asking the person. These are the shapes that crosses the process boundary.
 */

/** How the agent address was settled. */
export type AgentAddressSource =
  /** The server said where agents connect. */
  | 'discovered'
  /** The agent bridge answered `/health` at the address that was typed. */
  | 'probed'
  /** Nothing settled it: the person has to say. */
  | 'manual';

/** Why the person is being asked for the agent address. */
export type ManualAgentAddressReason =
  /** The server didn't say, and the typed address isn't the agent bridge. */
  | 'not_advertised'
  /** An address was found, but agents would refuse it: plain http to another
   * machine, credentials, a query or a fragment. */
  | 'refused';

export type ServerAddressResolution =
  | {
      kind: 'resolved';
      /** The origin Console signs in and calls `/gateway` on. */
      gatewayUrl: string;
      /** Where agents connect, or null when the person has to say. */
      apiUrl: string | null;
      apiSource: AgentAddressSource;
      /** Set only when `apiSource` is `manual`. */
      manualReason: ManualAgentAddressReason | null;
      /** The address found but refused, for the explanation, when the reason
       * is `refused`. */
      refusedApiUrl: string | null;
    }
  /** What was typed is not an http(s) URL. Nothing was requested. */
  | { kind: 'invalid' }
  /** Neither the typed address nor the one the server named answers as a
   * Switch server. */
  | { kind: 'unreachable'; address: string };

/**
 * Whether a saved server still agrees with itself about where agents connect:
 * its stored agent address against the one it advertises now. Only ever a
 * suggestion: nothing changes unless the person accepts it.
 */
export type ServerAddressCheck =
  | { status: 'match' }
  | { status: 'mismatch'; savedApiUrl: string; advertisedApiUrl: string }
  /** The server says nothing, cannot be asked, or is one Console assigns
   * addresses to itself (Switch Cloud, a server Console runs). */
  | { status: 'unknown' };
