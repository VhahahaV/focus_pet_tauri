# Luo Xiaohei Local Pack Notes

The local Luo Xiaohei pack is generated from a local checkout of
`https://github.com/jiang-taibai/IXiaoHei.git`, verified reachable at remote HEAD
`94d7eb55b85dcf10e47ad002d0417d0fb4d91436`.

The inspected upstream checkout contains `README.md` but no license file. Treat
the resulting frames as local-only test assets. Do not bundle, redistribute, or
publish these images without confirming rights from the original IP owner and
asset author.

Additional upstream research:

- `git ls-remote` shows only `master`, at the same HEAD as the local checkout.
- GitHub shows 4 commits and no releases.
- All commits were scanned for `src/org/taibai/hellohei/img`; no deleted or
  alternate action assets were found.
- The README preview GIF is a desktop/IDE demo recording, not a clean
  transparent sprite source, so it is not imported as action material.
- Static mood/item assets are preserved under `props/` for future interaction
  work: `emotion_increasing.png`, `smiling_clouds.png`, `egg.png`, `milk.png`,
  and `soap.png`.

`scripts/build-luoxiaohei-local-pack.py` is now a compatibility wrapper around
`scripts/build-local-pet-packs.py`. The generated Focus Pet mapping follows the
source code semantics instead of forcing every GIF into a movement role:

- `idle`, `focusStart`, `focusStable`, `breath`, `distractedLook`:
  `shake-head-txt.gif`, the upstream main continuous animation.
- `blink`, `stretch`: `licking the claw.gif`, upstream bath/cleaning action,
  used as a low-frequency grooming/rest cue.
- `sleep`: `bye.gif`, upstream exit animation, used as the closest available
  away posture.
- `wake`, `nudgeGentle`, `welcomeBack`, `mouseSummon`: `play heixiu.gif`,
  the closest available light interaction.
- `nudgeStrong`: `eat-watermelon-txt.gif`, a more visible attention action.
- `breakRelax`: `playing guitar.gif`, the upstream random click action and best
  rest companion.
- `breakEnd`: `eat drumstick.gif`, upstream food action, used as a recovery
  cue after rest.

The upstream project has no true walk, drag, landing, or cross-screen movement
sprite. Those runtime-only states should continue to resolve through Focus Pet
fallbacks rather than mapping food/rest assets to fake movement.
