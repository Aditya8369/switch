import { describe, expect, it } from 'vitest';
import { onboardingStore } from './onboarding-store';

describe('replaying the first-run pages', () => {
  it('keeps the flow on screen from its welcome page', () => {
    onboardingStore.reset();
    expect(onboardingStore.inProgress).toBe(false);

    onboardingStore.rehearse();

    expect(onboardingStore.page).toBe('welcome');
    expect(onboardingStore.inProgress).toBe(true);
  });

  it('survives walking back to the welcome page', () => {
    onboardingStore.rehearse();
    onboardingStore.goTo('howToRun');
    onboardingStore.goTo('welcome');

    expect(onboardingStore.inProgress).toBe(true);
  });

  it('ends when the flow is finished or left', () => {
    onboardingStore.rehearse();
    onboardingStore.reset();

    expect(onboardingStore.rehearsal).toBe(false);
    expect(onboardingStore.inProgress).toBe(false);
  });
});

describe('an invite link held through the flow', () => {
  const invite = { origin: 'https://switch.example.com', token: 'tok-1' };
  const addresses = {
    gatewayUrl: 'https://switch.example.com',
    apiUrl: 'https://switch-api.example.com',
  };

  it('is held with the addresses its server answered, until dropped', () => {
    onboardingStore.reset();
    onboardingStore.holdInvite(invite, addresses);

    expect(onboardingStore.invite).toEqual(invite);
    expect(onboardingStore.inviteAddresses).toEqual(addresses);

    onboardingStore.dropInvite();
    expect(onboardingStore.invite).toBeNull();
    expect(onboardingStore.inviteAddresses).toBeNull();
  });

  it('survives the connect and sign-in pages', () => {
    onboardingStore.reset();
    onboardingStore.holdInvite(invite);
    onboardingStore.goTo('connect');
    onboardingStore.goTo('signIn');
    onboardingStore.goTo('acceptInvite');

    expect(onboardingStore.invite).toEqual(invite);
  });

  it('is given up on when the user goes back to choosing how to run Switch, or to the start', () => {
    for (const page of ['howToRun', 'welcome'] as const) {
      onboardingStore.reset();
      onboardingStore.holdInvite(invite, addresses);
      onboardingStore.goTo(page);

      expect(onboardingStore.invite).toBeNull();
      expect(onboardingStore.inviteAddresses).toBeNull();
    }
  });

  it('is forgotten when the flow ends', () => {
    onboardingStore.holdInvite(invite, addresses);
    onboardingStore.reset();

    expect(onboardingStore.invite).toBeNull();
  });
});
