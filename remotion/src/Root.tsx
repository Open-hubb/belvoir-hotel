import "./index.css";
import { Composition } from "remotion";
import { Tour } from "./Tour";
import { FPS, totalFrames } from "./scenes";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Tour"
      component={Tour}
      durationInFrames={totalFrames()}
      fps={FPS}
      width={1280}
      height={720}
    />
  );
};
