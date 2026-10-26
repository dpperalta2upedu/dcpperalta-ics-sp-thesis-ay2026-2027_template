declare module "utif" {
  type UtifIfd = {
    width: number;
    height: number;
    [key: string]: unknown;
  };

  const UTIF: {
    decode(buffer: ArrayBuffer): UtifIfd[];
    decodeImage(buffer: ArrayBuffer, ifd: UtifIfd, ifds?: UtifIfd[]): void;
    toRGBA8(ifd: UtifIfd): Uint8Array;
  };

  export default UTIF;
}
