This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Mike Animation Layer (Lixia integration)

Mike is no longer a static model: he loads the canonical `MIKE_RealLixia.glb`,
waves on entry, breathes in a standing idle, and performs teaching gestures
that follow the lesson narration.

### What was added

- **`vendor/lixia-mike-animation-0.2.1.tgz`** — the `@lixia/mike-animation`
  runtime (animation registry, priority scheduler, crossfades, additive
  upper-body gesture layer, presentation director). It is vendored as a
  tarball so `npm install` works offline with no private registry. It is a
  regular dependency in `package.json`.
- **`public/lixia-animation/v1/`** — the committed *mobile-core pack*:
  the character GLB (~29 MB) plus 24 approved animation clips (~45 MB total;
  7 Mixamo full-body actions and 17 SeG upper-body conversational gestures)
  with integrity manifests. The full 2,600+ clip library intentionally stays
  out of git; these 24 cover the whole teaching-gesture vocabulary.
- **`components/MikeModel.tsx`** — rewritten as the animation bridge. It
  binds baked FBX clips to the GLB skeleton at runtime (unit conversion,
  root-rotation re-expression, finger damping) and runs two layers: a
  full-body queue (idle / wave / point / think / walk) and an additive
  upper-body queue so gestures blend over the idle without replacing the
  legs. In dev builds the API is exposed as `window.__lixiaMike` for manual
  testing (`playGesture('seg_377')`, `playAnimation('mixamo_1273')`, ...).
- **Gesture-aware lessons** — the Gemini `teach_lesson` schema now asks the
  model to pick one gesture intent per segment (`welcome`, `explain`,
  `emphasize`, `point`, `reveal`, `contrast`, `approve`, ...). The
  presentation director validates every intent against the approved
  registry before anything plays, so the LLM can never trigger an
  unapproved clip. Single board responses (charts, flowcharts, images) get
  a deterministic gesture. Missing gestures fall back to a rotation of
  natural teaching gestures.

### How it flows

```text
user prompt → /api/gemini (teach_lesson segments + gesture intents)
  → LixiaStudio walks segments: update board → resolve gesture via
    PresentationDirector → MikeModel plays it (upper-body gestures blend
    over idle; full-body clips replace idle and return automatically)
  → /api/tts speaks the narration in parallel
```

Everything animation-related runs in the browser — no extra server is
needed beyond the existing Next.js app.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
