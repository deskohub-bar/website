import Image from "next/image";
import type { ComponentProps } from "react";
import darkBgColor from "@/assets/logo/color-bg:dark.svg";
import lightBgColor from "@/assets/logo/color-bg:light.svg";
import darkBgCutout from "@/assets/logo/cutout-bg:dark.svg";
import lightBgCutout from "@/assets/logo/cutout-bg:light.svg";
import darkBgFancy from "@/assets/logo/fancy-bg:dark.svg";
import lightBgFancy from "@/assets/logo/fancy-bg:light.svg";
import darkBgPlain from "@/assets/logo/plain-bg:dark.svg";
import lightBgPlain from "@/assets/logo/plain-bg:light.svg";
import darkBgSmall from "@/assets/logo/small-bg:dark.svg";
import lightBgSmall from "@/assets/logo/small-bg:light.svg";

const logos = {
  dark: {
    color: darkBgColor,
    cutout: darkBgCutout,
    fancy: darkBgFancy,
    plain: darkBgPlain,
    small: darkBgSmall,
  },
  light: {
    color: lightBgColor,
    cutout: lightBgCutout,
    fancy: lightBgFancy,
    plain: lightBgPlain,
    small: lightBgSmall,
  },
};

export type LogoStyling = {
  color: keyof typeof logos;
  variant: keyof (typeof logos)[keyof typeof logos];
};

export default function Logo({
  styling,
  alt = "Deskohub logo",
  width: passedWidth,
  height: passedHeight,
  ...props
}: {
  styling: LogoStyling;
  alt?: string;
} & Omit<ComponentProps<typeof Image>, "src" | "alt">) {
  const {
    src,
    width: imageWidth,
    height: imageHeight,
  } = logos[styling.color][styling.variant];

  const aspectRatio = imageWidth / imageHeight;

  const width =
    passedWidth ||
    (passedHeight ? Number(passedHeight) * aspectRatio : imageWidth);
  const height =
    passedHeight ||
    (passedWidth ? Number(passedWidth) / aspectRatio : imageHeight);

  return <Image src={src} alt={alt} {...props} width={width} height={height} />;
}
