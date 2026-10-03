// How a picture wallpaper moves behind a profile (the browser draws the movement; the picture itself stays a still image).
export const WALLPAPER_MOTIONS = ["none", "zoom", "drift", "pan", "pulse"];
export const isWallpaperMotion = (value) => typeof value === "string" && WALLPAPER_MOTIONS.includes(value);
