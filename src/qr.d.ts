declare module "qrcode-generator" {
  interface QRCode {
    addData(data: string): void;
    make(): void;
    createSvgTag(options?: { scalable?: boolean; margin?: number }): string;
  }
  function qrcode(typeNumber: number, errorCorrectionLevel: "L" | "M" | "Q" | "H"): QRCode;
  export default qrcode;
}
