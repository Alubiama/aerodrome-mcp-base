export type AccountAssociation = { header: string; payload: string; signature: string };

export function miniappManifest(origin: string, association?: AccountAssociation) {
  return {
    ...(association ? { accountAssociation: association } : {}),
    miniapp: {
      version: '1',
      name: 'Collect',
      homeUrl: `${origin}/miniapp`,
      iconUrl: `${origin}/miniapp-icon.png`,
      splashImageUrl: `${origin}/miniapp-splash.png`,
      splashBackgroundColor: '#f7f8fc',
      subtitle: 'Find small Base balances',
      description: 'Explore small token balances on Base and preview read-only routes and estimated fees. Sending is disabled.',
      primaryCategory: 'finance',
      tags: ['base', 'tokens', 'wallet', 'portfolio'],
      requiredChains: ['eip155:8453'],
      noindex: true,
    },
  };
}

export function accountAssociationFromEnv(env: NodeJS.ProcessEnv, domain: string): AccountAssociation | undefined {
  const header = env.FARCASTER_HEADER;
  const payload = env.FARCASTER_PAYLOAD;
  const signature = env.FARCASTER_SIGNATURE;
  if (!header && !payload && !signature) return undefined;
  if (!header || !payload || !signature) throw new Error('Incomplete Farcaster account association.');
  let signedDomain: unknown;
  try { signedDomain = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).domain; }
  catch { throw new Error('Invalid Farcaster account association payload.'); }
  if (signedDomain !== domain) throw new Error('Farcaster account association domain mismatch.');
  return { header, payload, signature };
}
