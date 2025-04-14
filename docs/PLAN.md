# Field Work App Plan

## Core Idea

An application to assist with analyzing physical activities, starting with disc golf throws.

## Feature 1: Disc Golf Throw Analyzer

### Goal

Make it easy to film and review disc golf throws immediately after they happen.

### Setup

- **Main App:** Runs on a laptop.
- **Camera:** Uses an iPhone connected to the laptop as the video source.

### Recording Mode

- The app should continuously record video from the connected iPhone camera.
- Display a live preview of the camera feed.

### Loop Mode

- **Trigger:** Voice command (e.g., "loop", "replay").
- **Action:** When triggered, the app captures the last 5 seconds of video and immediately starts looping it on screen.
- **Playback Controls (while looping):**
  - `Spacebar`: Pause / Resume playback.
  - `Right Arrow`: Advance one frame forward.
  - `Left Arrow`: Go back one frame.
  - `Shift + Right Arrow`: Jump 5 frames forward.
  - `Shift + Left Arrow`: Jump 5 frames backward.
  - `Escape`: Exit loop mode and return to continuous recording mode.

### Saving & Export

- **Save Loop:** Ability to save the currently looping 5-second video clip as a file (e.g., .mp4).
- **Save Frame:** Ability to copy the currently displayed frame (while paused in loop mode) to the system clipboard as an image.

## Technical Considerations & Questions

- How will the iPhone connect to the laptop and stream video? (e.g., USB cable, Wi-Fi network, specific app/protocol like NDI?)
- What technology stack will be used? (Based on `package.json`, it looks like Next.js/React/TypeScript).
- Handling audio for voice commands.
- Video processing library for frame manipulation and looping.
- User interface design for preview, loop playback, and controls.
