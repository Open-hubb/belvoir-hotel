# Belvoir tour film (Remotion)

Source for `videos/belvoir-film.mp4` — the 32-second film in the site's
"Take a Tour" section. Combines the drone footage with the property
photography as Ken Burns moves and vertical camera tilts.

## Edit and re-render

    cd remotion
    npm install
    npx remotion studio          # live preview
    npx remotion render Tour --codec=h264 --crf=20 --output=../out.mp4

Then compress for the web and refresh the poster:

    ffmpeg -i ../out.mp4 -c:v libx264 -crf 28 -preset slow -pix_fmt yuv420p \
      -c:a aac -b:a 112k -movflags +faststart ../videos/belvoir-film.mp4
    ffmpeg -i ../videos/belvoir-film.mp4 -ss 1.6 -frames:v 1 -q:v 3 ../images/film-poster.jpg

## Where things live

- `src/scenes.ts` — the shot list: order, durations, camera moves, captions.
  Landscape photos use `land(...)` (pan + zoom), portrait photos use
  `port(...)` (vertical tilt, since they are far taller than a 16:9 frame).
- `src/Tour.tsx` — shot renderers, grade, captions, title and end cards.
- `public/img` — the stills used; `public/music.m4a` — audio bed taken from
  the original tour video and faded to match the film's length.

Changing a shot duration changes the total length: the composition length is
computed in `totalFrames()`, so re-render and regenerate `public/music.m4a`
to the new length if you change timings.
