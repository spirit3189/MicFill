/// <reference types="vite/client" />

declare module '*?script&iife' {
  const fileName: string;
  export default fileName;
}

declare module '*?url&no-inline' {
  const fileName: string;
  export default fileName;
}
