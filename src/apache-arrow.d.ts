declare module "apache-arrow" {
  export function tableFromIPC(input: Uint8Array | ArrayBuffer): unknown;
}
