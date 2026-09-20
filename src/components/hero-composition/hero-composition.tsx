export interface HeroCompositionProps {
  images: readonly [string, string, string];
  alt?: string;
}

/**
 * Three-shot hero identity: two supporting frames behind one larger focal frame.
 * The images are app content, not decoration; generated apps must replace all
 * three mock sources with a coherent, product-specific visual set.
 */
export function HeroComposition({ images, alt = "" }: HeroCompositionProps) {
  return (
    <div
      className="relative h-[106px] w-[372px] max-w-full"
      role={alt ? "img" : undefined}
      aria-label={alt || undefined}
    >
      <div className="absolute left-0 top-2.5 h-[88px] w-[42%] overflow-hidden rounded-q-400 opacity-80">
        <img src={images[0]} alt="" className="size-full object-cover" />
        <span aria-hidden className="absolute inset-0 bg-q-transparent-dark-20" />
      </div>
      <div className="absolute right-0 top-2.5 h-[88px] w-[42%] overflow-hidden rounded-q-400 opacity-80">
        <img src={images[2]} alt="" className="size-full object-cover" />
        <span aria-hidden className="absolute inset-0 bg-q-transparent-dark-20" />
      </div>
      <div className="absolute left-1/2 top-0 z-[1] h-[106px] w-[50.25%] -translate-x-1/2 overflow-hidden rounded-q-400 border border-q-border-subtle bg-q-background-secondary shadow-q-raised">
        <img src={images[1]} alt="" className="size-full object-cover" />
      </div>
    </div>
  );
}
