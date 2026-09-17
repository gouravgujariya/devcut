# DevCut Social Agent

This folder defines the first version of DevCut's social-content workflow using self-hosted TryPost.

## Goal

Build a repeatable weekly loop:

1. Research fresh developer memes/trends.
2. Select only trends that fit developer culture and DevCut's brand.
3. Generate a Reel/meme/carousel concept.
4. Require human approval while the brand voice is still being learned.
5. Schedule approved content through TryPost.
6. Review shares, saves, profile visits, website clicks, installs, and activations each week.

## Architecture

```text
Trend research -> DevCut content agent -> Human approval -> TryPost -> Instagram
                                                        -> analytics -> next week's research
```

TryPost publishes through official platform APIs and supports self-hosting plus API/MCP access. We deliberately avoid browser automation for Instagram publishing.

## Initial posting cadence

- Monday: trending developer meme
- Tuesday: relatable developer Reel
- Wednesday: carousel
- Thursday: trend/audio adapted to developer life
- Friday: meme/poster
- Saturday: DevCut founder/build-in-public post
- Sunday: lighter community/relatable post

The weekly trend-based posts should be generated close to publish time rather than one month in advance.

## Safety rule

Until DevCut has a stable content voice, every scheduled post requires human approval. The agent may research, draft and prepare a queue, but it must not auto-publish a newly discovered trend without approval.

## TryPost deployment

Use the upstream production compose file from `trypostit/trypost` rather than maintaining a fork unless DevCut-specific changes become necessary.

Minimum production configuration:

- Public HTTPS URL for TryPost
- PostgreSQL
- Redis
- Persistent application storage
- `APP_KEY`
- Laravel Passport keys for durable API/MCP tokens
- Instagram/Meta client ID and client secret

Instagram callback URL:

```text
https://<TRYPOST_DOMAIN>/accounts/instagram/callback
```

Do not commit Meta credentials, application keys, database passwords, API tokens, or Passport private keys.

## First launch checklist

1. Deploy upstream TryPost on a small server/Railway/Coolify instance.
2. Point a subdomain such as `social.devcut.co.in` at the deployment.
3. Enable HTTPS.
4. Create a Meta developer app and configure the Instagram OAuth callback.
5. Add the Instagram client ID/secret to TryPost's runtime environment.
6. Connect the DevCut Instagram professional account in TryPost.
7. Create a TryPost workspace for DevCut.
8. Add the brand rules in `devcut-brand.md`.
9. Load the weekly slots from `content-plan.yaml`.
10. Schedule one private/test post before enabling the normal weekly queue.

## Success metrics

Do not optimize primarily for likes. Track:

- Shares per reach
- Saves per reach
- Profile visits
- Link clicks
- DevCut installs attributed to Instagram
- Activation after install
- Weekly active DevCut users from Instagram

## Phase 2 automation

After 30-50 approved posts, evaluate which parts can become automatic. The long-term agent can generate a weekly candidate queue, but auto-publishing should be limited to repeatable low-risk formats whose tone has proven reliable.
