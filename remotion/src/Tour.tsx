import React from "react";
import {
  AbsoluteFill,
  Img,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Easing,
  Sequence,
} from "remotion";
import { Video, Audio } from "@remotion/media";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { slide } from "@remotion/transitions/slide";
import { loadFont as loadCinzel } from "@remotion/google-fonts/Cinzel";
import { loadFont as loadCormorant } from "@remotion/google-fonts/CormorantGaramond";
import { loadFont as loadJosefin } from "@remotion/google-fonts/JosefinSans";
import { SCENES, FPS, TRANSITION, Move, Scene } from "./scenes";

const { fontFamily: CINZEL } = loadCinzel();
const { fontFamily: CORMORANT } = loadCormorant();
const { fontFamily: JOSEFIN } = loadJosefin();

const NAVY = "#0C1B33";
const GOLD = "#C9A96E";
const GOLD_PALE = "#EBD8AE";
const CREAM = "#FBF6EC";

const EASE = Easing.bezier(0.33, 0, 0.2, 1);

/* ─────────── Ken Burns photo ─────────── */
const KenBurns: React.FC<{ src: string; move: Move; dur: number }> = ({
  src,
  move,
  dur,
}) => {
  const frame = useCurrentFrame();
  const total = Math.round(dur * FPS);
  const t = (out: [number, number]) =>
    interpolate(frame, [0, total], out, {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: EASE,
    });

  const scale = t(move.scale);
  const x = move.x ? t(move.x) : 0;
  const y = move.y ? t(move.y) : 0;

  return (
    <AbsoluteFill style={{ overflow: "hidden", backgroundColor: NAVY }}>
      <Img
        src={staticFile(src)}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `scale(${scale}) translate(${x}%, ${y}%)`,
        }}
      />
    </AbsoluteFill>
  );
};

/* ─────────── Portrait shot: camera tilts vertically through the room ───────────
   The image is laid in at full frame width, so a 3:4 photo stands ~2.4x taller
   than the frame. Sliding it vertically reads as the camera tilting from the
   ceiling down to the floor (or back up), revealing the whole room.          */
const TiltShot: React.FC<{
  src: string;
  dur: number;
  tilt: [number, number];
  zoom: [number, number];
  aspect: number;
}> = ({ src, dur, tilt, zoom, aspect }) => {
  const frame = useCurrentFrame();
  const { width: fw, height: fh } = useVideoConfig();
  const total = Math.round(dur * FPS);
  const t = (out: [number, number]) =>
    interpolate(frame, [0, total], out, {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: EASE,
    });

  const zoomNow = t(zoom);
  const imgW = fw * zoomNow;
  const imgH = imgW / aspect;
  const travel = Math.max(0, imgH - fh);
  const y = -travel * t(tilt);
  const x = -(imgW - fw) / 2;

  return (
    <AbsoluteFill style={{ overflow: "hidden", backgroundColor: NAVY }}>
      <Img
        src={staticFile(src)}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: imgW,
          height: imgH,
          objectFit: "cover",
          transform: `translate(${x}px, ${y}px)`,
        }}
      />
    </AbsoluteFill>
  );
};

/* ─────────── Cinematic finish: vignette + warm grade + grain ─────────── */
const Grade: React.FC = () => (
  <AbsoluteFill style={{ pointerEvents: "none" }}>
    <AbsoluteFill
      style={{
        background:
          "radial-gradient(115% 90% at 50% 45%, rgba(0,0,0,0) 42%, rgba(6,13,22,0.55) 100%)",
      }}
    />
    <AbsoluteFill
      style={{
        background:
          "linear-gradient(to bottom, rgba(6,13,22,0.42) 0%, rgba(6,13,22,0) 26%, rgba(6,13,22,0) 58%, rgba(6,13,22,0.62) 100%)",
      }}
    />
    <AbsoluteFill
      style={{
        backgroundColor: "#B08D57",
        mixBlendMode: "overlay",
        opacity: 0.07,
      }}
    />
  </AbsoluteFill>
);

/* ─────────── Lower-third caption ─────────── */
const Caption: React.FC<{ chapter?: string; caption: string; dur: number }> = ({
  chapter,
  caption,
  dur,
}) => {
  const frame = useCurrentFrame();
  const total = Math.round(dur * FPS);
  const inAt = 6;
  const outAt = total - 10;

  const op = interpolate(
    frame,
    [inAt, inAt + 14, Math.max(outAt, inAt + 20), total - 2],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE },
  );
  const rise = interpolate(frame, [inAt, inAt + 18], [16, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  const rule = interpolate(frame, [inAt + 4, inAt + 26], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "flex-start",
        padding: "0 0 52px 64px",
      }}
    >
      <div style={{ opacity: op, transform: `translateY(${rise}px)` }}>
        {chapter ? (
          <div
            style={{
              fontFamily: JOSEFIN,
              fontSize: 15,
              letterSpacing: "0.42em",
              textTransform: "uppercase",
              color: GOLD_PALE,
              marginBottom: 10,
              textShadow: "0 2px 18px rgba(6,13,22,0.9)",
            }}
          >
            {chapter}
          </div>
        ) : null}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
          }}
        >
          <div
            style={{
              width: 46,
              height: 1,
              background: GOLD,
              transform: `scaleX(${rule})`,
              transformOrigin: "left",
            }}
          />
          <div
            style={{
              fontFamily: CORMORANT,
              fontStyle: "italic",
              fontSize: 40,
              lineHeight: 1.1,
              color: CREAM,
              textShadow: "0 2px 26px rgba(6,13,22,0.85)",
            }}
          >
            {caption}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

/* ─────────── Opening title ─────────── */
const TitleCard: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  const total = Math.round(dur * FPS);

  const markOp = interpolate(frame, [10, 32], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  const titleOp = interpolate(frame, [20, 46], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  const titleScale = interpolate(frame, [20, total], [1.06, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  const subOp = interpolate(frame, [40, 64], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  const outOp = interpolate(frame, [total - 22, total - 4], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        textAlign: "center",
        opacity: outOp,
      }}
    >
      <div
        style={{
          opacity: markOp,
          fontFamily: JOSEFIN,
          fontSize: 15,
          letterSpacing: "0.5em",
          textTransform: "uppercase",
          color: GOLD_PALE,
          display: "flex",
          alignItems: "center",
          gap: 20,
          textShadow: "0 2px 20px rgba(6,13,22,0.9)",
        }}
      >
        <span style={{ width: 52, height: 1, background: GOLD }} />
        Freetown · Sierra Leone
        <span style={{ width: 52, height: 1, background: GOLD }} />
      </div>

      <div
        style={{
          opacity: titleOp,
          transform: `scale(${titleScale})`,
          fontFamily: CINZEL,
          fontSize: 96,
          letterSpacing: "0.06em",
          color: "#fff",
          marginTop: 22,
          textShadow: "0 4px 44px rgba(6,13,22,0.7)",
        }}
      >
        BELVOIR
      </div>

      <div
        style={{
          opacity: subOp,
          fontFamily: CORMORANT,
          fontStyle: "italic",
          fontSize: 34,
          color: "rgba(255,255,255,0.92)",
          marginTop: 10,
          textShadow: "0 2px 26px rgba(6,13,22,0.85)",
        }}
      >
        A tour of the residence
      </div>
    </AbsoluteFill>
  );
};

/* ─────────── Closing card ─────────── */
const OutroCard: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  const total = Math.round(dur * FPS);

  const logoOp = interpolate(frame, [14, 40], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  const logoRise = interpolate(frame, [14, 46], [22, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  const lineOp = interpolate(frame, [34, 58], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  const ctaOp = interpolate(frame, [50, 74], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  const dim = interpolate(frame, [0, 44], [0.15, 0.82], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  const fadeOut = interpolate(frame, [total - 20, total - 1], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <>
      <AbsoluteFill style={{ backgroundColor: NAVY, opacity: dim }} />
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          textAlign: "center",
          opacity: fadeOut,
        }}
      >
        <div
          style={{
            opacity: logoOp,
            transform: `translateY(${logoRise}px)`,
            fontFamily: CINZEL,
            fontSize: 88,
            letterSpacing: "0.08em",
            color: "#fff",
            textShadow: "0 4px 40px rgba(0,0,0,0.6)",
          }}
        >
          BELVOIR
        </div>
        <div
          style={{
            opacity: logoOp,
            fontFamily: JOSEFIN,
            fontSize: 13,
            letterSpacing: "0.36em",
            textTransform: "uppercase",
            color: GOLD_PALE,
            marginTop: 8,
          }}
        >
          Hotel · Serviced Apartments · Residence
        </div>
        <div
          style={{
            width: 120,
            height: 1,
            background: GOLD,
            opacity: lineOp,
            margin: "26px 0 20px",
          }}
        />
        <div
          style={{
            opacity: ctaOp,
            fontFamily: CORMORANT,
            fontStyle: "italic",
            fontSize: 34,
            color: CREAM,
            textShadow: "0 2px 20px rgba(6,13,22,0.9)",
          }}
        >
          Be inspired. We deliver.
        </div>
        <div
          style={{
            opacity: ctaOp,
            fontFamily: JOSEFIN,
            fontSize: 14,
            letterSpacing: "0.32em",
            textTransform: "uppercase",
            color: GOLD_PALE,
            marginTop: 18,
          }}
        >
          Book direct · Freetown, Sierra Leone
        </div>
      </AbsoluteFill>
    </>
  );
};

/* ─────────── Scene renderer ─────────── */
const SceneView: React.FC<{ scene: Scene }> = ({ scene }) => {
  const { fps } = useVideoConfig();

  if (scene.kind === "video") {
    return (
      <AbsoluteFill style={{ backgroundColor: NAVY }}>
        <Video
          src={staticFile("belvoir-tour.mp4")}
          trimBefore={Math.round(scene.startAt * fps)}
          muted
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
        <Grade />
        {scene.title ? <TitleCard dur={scene.dur} /> : null}
        {scene.outro ? <OutroCard dur={scene.dur} /> : null}
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill>
      {scene.portrait ? (
        <TiltShot
          src={scene.src}
          dur={scene.dur}
          tilt={scene.tilt ?? [0.25, 0.7]}
          zoom={scene.move.scale}
          aspect={scene.aspect ?? 0.75}
        />
      ) : (
        <KenBurns src={scene.src} move={scene.move} dur={scene.dur} />
      )}
      <Grade />
      <Caption
        chapter={scene.chapter}
        caption={scene.caption}
        dur={scene.dur}
      />
    </AbsoluteFill>
  );
};

/* ─────────── Main composition ─────────── */
export const Tour: React.FC = () => {
  const { durationInFrames } = useVideoConfig();

  return (
    <AbsoluteFill style={{ backgroundColor: NAVY }}>
      <Sequence>
        <Audio src={staticFile("music.m4a")} volume={0.85} />
      </Sequence>

      <TransitionSeries>
        {SCENES.map((scene, i) => {
          const frames = Math.round(scene.dur * FPS);
          // A gentle slide every few shots reads as the camera moving on
          const useSlide = scene.kind === "photo" && i === 7;
          return (
            <React.Fragment key={i}>
              <TransitionSeries.Sequence durationInFrames={frames}>
                <SceneView scene={scene} />
              </TransitionSeries.Sequence>
              {i < SCENES.length - 1 ? (
                <TransitionSeries.Transition
                  presentation={
                    useSlide ? slide({ direction: "from-right" }) : fade()
                  }
                  timing={linearTiming({ durationInFrames: TRANSITION })}
                />
              ) : null}
            </React.Fragment>
          );
        })}
      </TransitionSeries>

      <FadeEdges duration={durationInFrames} />
    </AbsoluteFill>
  );
};

const FadeEdges: React.FC<{ duration: number }> = ({ duration }) => {
  const frame = useCurrentFrame();
  const op = interpolate(
    frame,
    [0, 14, duration - 16, duration - 1],
    [1, 0, 0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  return (
    <AbsoluteFill
      style={{ backgroundColor: "#04080e", opacity: op, pointerEvents: "none" }}
    />
  );
};
