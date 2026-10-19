import type {
  ManualAgentAddressReason,
  ServerAddressResolution,
} from '@shared/core/switch-servers/server-address';
import { sameApiEndpoint, urlOrigin } from '@shared/core/switch-servers/switch-servers';

/**
 * What the connect form decides, kept apart from React so it can be tested
 * without a browser.
 *
 * The form asks for one address. Before anything is saved, that address is
 * resolved into the server's two origins and the agent address is shown, so
 * the person sees where agents will connect and can change it. An agent
 * address that could not be settled turns into a required field with the
 * reason. Editing a saved server starts from its stored addresses and leaves
 * them alone unless the address or the agent address is actually changed; a
 * changed agent address is confirmed first, because saving it rewrites every
 * member agent's credentials and restarts this computer's controller.
 */

/** The addresses already saved for the server this form edits. */
export type SavedAddresses = { gatewayUrl: string; apiUrl: string };

export type AddressFormState = {
  /** What is in the address field. */
  address: string;
  /** The last resolution, and the address it was for. */
  resolution: { forAddress: string; result: ServerAddressResolution } | null;
  resolving: boolean;
  /** The saved server's addresses, when editing or coming back to fix one. */
  saved: SavedAddresses | null;
  /** The agent address the person typed, once they chose to change it; null
   * while the resolved (or saved) one stands. */
  apiOverride: string | null;
  /** The person was shown that saving reconfigures their agents, and the next
   * press saves. */
  confirmingApiChange: boolean;
};

export function initialAddressFormState(
  saved: SavedAddresses | null,
  initialAddress: string | null
): AddressFormState {
  return {
    address: initialAddress ?? saved?.gatewayUrl ?? '',
    resolution: null,
    resolving: false,
    saved,
    apiOverride: null,
    confirmingApiChange: false,
  };
}

/** Where the agent address on screen came from. `saved` is the stored one. */
export type ShownAgentAddressSource = 'discovered' | 'probed' | 'saved';

export type AddressFormView = {
  /** Shown under the address field. */
  addressMessage: string | null;
  /** The origin that would be saved as the Gateway URL. */
  gatewayUrl: string | null;
  /** The agent address shown read-only, with where it came from. */
  shownApiUrl: string | null;
  shownApiSource: ShownAgentAddressSource | null;
  /** Whether the agent-address field is open (asked for, or being changed). */
  showApiField: boolean;
  /** Why the field was opened by the form rather than the person. */
  manualReason: ManualAgentAddressReason | null;
  refusedApiUrl: string | null;
  apiMessage: string | null;
  /** The agent address that would be saved. */
  apiUrl: string | null;
  /** Whether saving would change the saved agent address. */
  apiChanged: boolean;
  /** What pressing the button does now. */
  next: 'resolve' | 'confirm' | 'save' | 'none';
};

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function viewAddressForm(state: AddressFormState): AddressFormView {
  const typed = state.address.trim();
  const typedOrigin = isHttpUrl(typed) ? urlOrigin(typed) : null;
  const base: AddressFormView = {
    addressMessage: null,
    gatewayUrl: null,
    shownApiUrl: null,
    shownApiSource: null,
    showApiField: false,
    manualReason: null,
    refusedApiUrl: null,
    apiMessage: null,
    apiUrl: null,
    apiChanged: false,
    next: 'none',
  };

  if (typed.length === 0) return base;
  if (typedOrigin === null) {
    return { ...base, addressMessage: 'Enter a full address, e.g. https://switch.example.com' };
  }
  if (state.resolving) return base;

  // The settled addresses before any override: the saved ones while the
  // address still names the saved server, otherwise the last resolution of
  // exactly this address.
  let gatewayUrl: string | null = null;
  let resolvedApi: string | null = null;
  let source: ShownAgentAddressSource | null = null;
  let manualReason: ManualAgentAddressReason | null = null;
  let refusedApiUrl: string | null = null;

  const current = state.resolution?.forAddress === typed ? state.resolution.result : null;
  if (state.saved && urlOrigin(state.saved.gatewayUrl) === typedOrigin && current === null) {
    gatewayUrl = state.saved.gatewayUrl;
    resolvedApi = state.saved.apiUrl;
    source = 'saved';
  } else if (current === null) {
    return { ...base, next: 'resolve' };
  } else if (current.kind === 'invalid') {
    return { ...base, addressMessage: 'Enter a full address, e.g. https://switch.example.com' };
  } else if (current.kind === 'unreachable') {
    return {
      ...base,
      addressMessage: `Could not reach a Switch server at ${current.address}. Check the address, and that the server is running.`,
    };
  } else {
    gatewayUrl = current.gatewayUrl;
    resolvedApi = current.apiUrl;
    source = current.apiSource === 'manual' ? null : current.apiSource;
    manualReason = current.manualReason;
    refusedApiUrl = current.refusedApiUrl;
  }

  const fieldOpen = state.apiOverride !== null || resolvedApi === null;
  const typedApi = (state.apiOverride ?? '').trim();
  let apiUrl: string | null = resolvedApi;
  let apiMessage: string | null = null;
  if (fieldOpen) {
    apiUrl = isHttpUrl(typedApi) ? typedApi : null;
    if (typedApi.length > 0 && apiUrl === null)
      apiMessage = 'Enter a full address, e.g. https://switch-api.example.com';
  }

  const apiChanged =
    state.saved !== null && apiUrl !== null && !sameApiEndpoint(state.saved.apiUrl, apiUrl);

  let next: AddressFormView['next'] = 'none';
  if (gatewayUrl !== null && apiUrl !== null) {
    next = apiChanged && !state.confirmingApiChange ? 'confirm' : 'save';
  }

  return {
    addressMessage: null,
    gatewayUrl,
    shownApiUrl: fieldOpen ? null : resolvedApi,
    shownApiSource: fieldOpen ? null : source,
    showApiField: fieldOpen,
    manualReason: state.apiOverride === null ? manualReason : null,
    refusedApiUrl: state.apiOverride === null ? refusedApiUrl : null,
    apiMessage,
    apiUrl,
    apiChanged,
    next,
  };
}

/** The address was edited: anything worked out for the old one no longer applies. */
export function withAddress(state: AddressFormState, address: string): AddressFormState {
  return { ...state, address, apiOverride: null, confirmingApiChange: false };
}

/** The person chose to change the agent address, starting from the shown one. */
export function withApiFieldOpened(
  state: AddressFormState,
  shown: string | null
): AddressFormState {
  return { ...state, apiOverride: shown ?? '', confirmingApiChange: false };
}

export function withApiOverride(state: AddressFormState, apiOverride: string): AddressFormState {
  return { ...state, apiOverride, confirmingApiChange: false };
}

export function withResolving(state: AddressFormState): AddressFormState {
  return { ...state, resolving: true };
}

export function withResolution(
  state: AddressFormState,
  forAddress: string,
  result: ServerAddressResolution
): AddressFormState {
  // A resolution that came back for an address the person has since changed
  // is dropped; the current address resolves on its own.
  if (forAddress !== state.address.trim()) return { ...state, resolving: false };
  return { ...state, resolving: false, resolution: { forAddress, result } };
}

export function withConfirming(state: AddressFormState, confirming: boolean): AddressFormState {
  return { ...state, confirmingApiChange: confirming };
}

/** Plain words for why the agent address is being asked for. */
export function manualReasonText(
  reason: ManualAgentAddressReason,
  refusedApiUrl: string | null
): string {
  switch (reason) {
    case 'not_advertised':
      return "This server didn't say where agents connect. Ask whoever set it up for its agent address (often the same host on another port).";
    case 'refused':
      return `Agents can't use ${refusedApiUrl ?? 'the address this server gave'}: they need https, except for a server on this computer. Enter the address agents should use.`;
  }
}
