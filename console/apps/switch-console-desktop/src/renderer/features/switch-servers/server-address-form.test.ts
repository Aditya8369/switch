import { describe, expect, it } from 'vitest';
import type { ServerAddressResolution } from '@shared/core/switch-servers/server-address';
import {
  type AddressFormState,
  initialAddressFormState,
  manualReasonText,
  viewAddressForm,
  withAddress,
  withApiFieldOpened,
  withApiOverride,
  withConfirming,
  withResolution,
  withResolving,
} from './server-address-form';

const DASH = 'https://switch.example.com';
const API = 'https://switch-api.example.com';

const discovered: ServerAddressResolution = {
  kind: 'resolved',
  gatewayUrl: DASH,
  apiUrl: API,
  apiSource: 'discovered',
  manualReason: null,
  refusedApiUrl: null,
};
const notAdvertised: ServerAddressResolution = {
  kind: 'resolved',
  gatewayUrl: DASH,
  apiUrl: null,
  apiSource: 'manual',
  manualReason: 'not_advertised',
  refusedApiUrl: null,
};

/** A new form with `address` typed and resolved to `result`. */
function resolvedForm(address: string, result: ServerAddressResolution): AddressFormState {
  return withResolution(withAddress(initialAddressFormState(null, null), address), address, result);
}

describe('adding a server', () => {
  it('shows one address field and asks for nothing else until it is resolved', () => {
    const view = viewAddressForm(initialAddressFormState(null, null));

    expect(view.showApiField).toBe(false);
    expect(view.next).toBe('none');
  });

  it('resolves a typed address before it can save', () => {
    const view = viewAddressForm(withAddress(initialAddressFormState(null, null), DASH));

    expect(view.next).toBe('resolve');
    expect(view.shownApiUrl).toBeNull();
  });

  it.each(['ftp://switch.example.com', 'switch.example.com', 'not a url'])(
    'refuses %j without resolving it',
    (typed) => {
      const view = viewAddressForm(withAddress(initialAddressFormState(null, null), typed));

      expect(view.addressMessage).toMatch(/full address/);
      expect(view.next).toBe('none');
    }
  );

  it('waits while resolving', () => {
    const view = viewAddressForm(
      withResolving(withAddress(initialAddressFormState(null, null), DASH))
    );

    expect(view.next).toBe('none');
  });

  it('shows the discovered agent address before saving it', () => {
    const view = viewAddressForm(resolvedForm(DASH, discovered));

    expect(view).toMatchObject({
      gatewayUrl: DASH,
      shownApiUrl: API,
      shownApiSource: 'discovered',
      showApiField: false,
      apiUrl: API,
      next: 'save',
    });
  });

  it('saves the agent address the person typed instead of the resolved one', () => {
    let state = resolvedForm(DASH, discovered);
    state = withApiFieldOpened(state, viewAddressForm(state).shownApiUrl);

    expect(state.apiOverride).toBe(API);
    state = withApiOverride(state, 'https://agents.internal.example.com');

    expect(viewAddressForm(state)).toMatchObject({
      showApiField: true,
      shownApiUrl: null,
      apiUrl: 'https://agents.internal.example.com',
      next: 'save',
    });
  });

  it('opens a required agent-address field, with the reason, when nothing settled it', () => {
    const state = resolvedForm(DASH, notAdvertised);
    const view = viewAddressForm(state);

    expect(view).toMatchObject({
      showApiField: true,
      manualReason: 'not_advertised',
      next: 'none',
    });
    expect(viewAddressForm(withApiOverride(state, 'nope')).apiMessage).toMatch(/full address/);
    expect(viewAddressForm(withApiOverride(state, API))).toMatchObject({
      apiUrl: API,
      next: 'save',
    });
  });

  it('says which address agents would refuse', () => {
    const refused: ServerAddressResolution = {
      ...notAdvertised,
      manualReason: 'refused',
      refusedApiUrl: 'http://switch-api.example.com',
    };
    const view = viewAddressForm(resolvedForm(DASH, refused));

    expect(view.refusedApiUrl).toBe('http://switch-api.example.com');
    expect(manualReasonText('refused', view.refusedApiUrl)).toContain(
      'http://switch-api.example.com'
    );
    expect(manualReasonText('not_advertised', null)).toMatch(/didn't say where agents connect/);
  });

  it('reports an unreachable address and offers nothing to save', () => {
    const view = viewAddressForm(resolvedForm(DASH, { kind: 'unreachable', address: DASH }));

    expect(view.addressMessage).toMatch(
      /Could not reach a Switch server at https:\/\/switch.example.com/
    );
    expect(view.next).toBe('none');
  });

  it('forgets the resolution once the address is edited', () => {
    let state = resolvedForm(DASH, discovered);
    state = withAddress(state, 'https://other.example.com');

    expect(viewAddressForm(state).next).toBe('resolve');
  });

  it('drops a resolution that arrives for an address since changed', () => {
    let state = withResolving(withAddress(initialAddressFormState(null, null), DASH));
    state = withAddress(state, 'https://other.example.com');
    state = withResolution(state, DASH, discovered);

    expect(state.resolution).toBeNull();
    expect(state.resolving).toBe(false);
  });
});

describe('editing a saved server', () => {
  const saved = { gatewayUrl: DASH, apiUrl: API };

  it('starts from the saved address and agent address, and saves them unchanged', () => {
    const state = initialAddressFormState(saved, null);
    const view = viewAddressForm(state);

    expect(state.address).toBe(DASH);
    expect(view).toMatchObject({
      gatewayUrl: DASH,
      shownApiUrl: API,
      shownApiSource: 'saved',
      apiUrl: API,
      apiChanged: false,
      next: 'save',
    });
  });

  it('treats a trailing slash on the saved address as the same server', () => {
    const view = viewAddressForm(withAddress(initialAddressFormState(saved, null), `${DASH}/`));

    expect(view).toMatchObject({ gatewayUrl: DASH, apiUrl: API, next: 'save' });
  });

  it('asks for confirmation before saving a changed agent address', () => {
    let state = initialAddressFormState(saved, null);
    state = withApiOverride(withApiFieldOpened(state, API), 'https://agents.example.com');

    expect(viewAddressForm(state)).toMatchObject({ apiChanged: true, next: 'confirm' });
    expect(viewAddressForm(withConfirming(state, true)).next).toBe('save');
    // Cancelling the confirmation goes back to asking.
    expect(viewAddressForm(withConfirming(state, false)).next).toBe('confirm');
  });

  it('does not ask to confirm an agent address that only differs by a slash', () => {
    let state = initialAddressFormState(saved, null);
    state = withApiOverride(withApiFieldOpened(state, API), `${API}/`);

    expect(viewAddressForm(state)).toMatchObject({ apiChanged: false, next: 'save' });
  });

  it('resolves a new address, and confirms when it moves the agent address', () => {
    let state = withAddress(initialAddressFormState(saved, null), 'https://new.example.com');
    expect(viewAddressForm(state).next).toBe('resolve');

    state = withResolution(state, 'https://new.example.com', {
      ...discovered,
      gatewayUrl: 'https://new.example.com',
      apiUrl: 'https://new-api.example.com',
    });
    expect(viewAddressForm(state)).toMatchObject({
      gatewayUrl: 'https://new.example.com',
      apiUrl: 'https://new-api.example.com',
      next: 'confirm',
    });
  });
});
