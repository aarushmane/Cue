import Image from "next/image";

export function Logo() {
  return (
    <div className="workspace-logo">
      <Image src="/brand/logo.png" alt="Logo" width={64} height={64} priority />
    </div>
  );
}
