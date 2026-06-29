# Roza assets

Committed binary assets referenced by Roza's profile. These are part of the
repository (not generated at build time) so the running container always has
them available at the path stored in `RozaProfile.avatarAssetPath`.

## `roza-avatar.png`

The avatar referenced by `DEFAULT_PROFILE.avatarAssetPath` (`assets/roza-avatar.png`).

**This is a placeholder.** It is a small, valid RGB PNG (a solid purple field
with a light "R" monogram) generated so the asset path always resolves to a
real image. **The operator should replace it with Roza's real avatar artwork**
(same filename and path) once available.

### How the avatar is actually applied to the Telegram channel

On the default grammY / Telegram **Bot API** path, the bot's avatar and display
name are **set once via BotFather** — this is a manual operator step, not an
automated runtime action. The profile's `telegramIdentity` field only drives how
Roza *presents* herself in reply text; it does not upload the photo. (The
optional GramJS / MTProto path can upload the avatar programmatically, but it is
documented as the non-default alternative.)

So this committed file is the source-of-truth artwork the operator uploads to
BotFather; the service itself does not push it to Telegram.
