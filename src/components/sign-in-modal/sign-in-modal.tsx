import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, WandSparkles } from "lucide-react";
import { Button } from "@higgsfield/quanta/button";
import { Icon } from "@higgsfield/quanta/icon";
import { Modal } from "@higgsfield/quanta/modal";

const SLIDE_DURATION = 5000;
const STATIC_MEDIA = "https://static.higgsfield.ai";

interface SlideData {
  id: string;
  title: string;
  description: string;
  type: "static" | "video";
  media: string;
  thumbnail?: string;
  badges: { icon: ReactNode; label: string }[];
}

function DiamondIcon() {
  return (
    <svg viewBox="0 0 14 14" fill="none" className="size-3.5" aria-hidden>
      <path
        d="M5.128 2.188c-.523 0-1.025.204-1.398.57L2.03 4.419a2 2 0 0 0-.016 2.845l3.572 3.572a2 2 0 0 0 2.828 0l3.572-3.572a2 2 0 0 0-.016-2.845l-1.7-1.662a2 2 0 0 0-1.398-.57H5.128Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4.958 4.52 3.646 5.834l1.312 1.312"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function HiggsfieldMark({ className = "size-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 34.286 34.286" fill="none" className={className} aria-hidden>
      <path
        d="m29.071 16.775-.023-.249c-.215-2.386-1.768-6.875-6.074-6.875-3.196 0-5.61 3.155-7.741 5.936-1.7 2.228-3.173 4.138-4.794 4.138-.431-.045-.986-.26-1.326-.746-.306-.441-.385-1.006-.227-1.685.25-1.074 1.678-2.069 3.185-3.131.827-.566 1.677-1.165 2.267-1.742 1.7-1.639 2.561-2.826 2.561-4.737s-1.054-2.86-1.938-3.268c-1.768-.813-4.363-.339-6.018 1.086-.249.226-.498.44-.725.645-1.666 1.48-2.788 2.487-5.361 1.718v3.098c3.411 1.504 6.279-1.368 7.367-2.691.838-.87 1.722-1.38 2.38-1.38h.034c.295.012.544.125.726.329.294.339.408.735.351 1.175-.125.928-1.088 2.013-2.856 3.2-2.074 1.391-5.542 3.72-5.814 6.648-.204 2.104.884 4.206 2.584 5.02 3.967 1.877 6.381-1.356 8.942-4.771 1.961-2.634 3.819-5.133 6.403-5.133 2.323 0 3.185 1.922 3.185 3.132v.237l-.227.045c-5.633.995-8.704 6.264-8.704 8.695 0 2.43 2.063 4.51 4.601 4.51 2.97 0 6.642-2.532 7.231-9.655l.023-.26h2.346v-3.29h-2.357Zm-3.071 3.651c-.454 4.263-2.641 6.253-3.967 6.253-.601 0-1.439-.498-1.439-1.425 0-1.04 1.553-4.194 5.043-5.133l.408-.101-.045.406Z"
        fill="currentColor"
      />
    </svg>
  );
}

const slides: SlideData[] = [
  {
    id: "seedance-2-4k",
    title: "SEEDANCE 2.0 4K",
    description: "The world’s most capable video model at full 4K",
    type: "video",
    media: `${STATIC_MEDIA}/auth/seedance.mp4`,
    badges: [{ icon: <DiamondIcon />, label: "4K Resolution" }],
  },
  {
    id: "nano-banana-pro",
    title: "NANO BANANA PRO 4K",
    description: "The best image model, for the best price in the industry, only on Higgsfield",
    type: "static",
    media: `${STATIC_MEDIA}/quiz-v2/auth-1.webp`,
    badges: [{ icon: <DiamondIcon />, label: "4K Resolution" }],
  },
  {
    id: "higgsfield-soul",
    title: "HIGGSFIELD SOUL",
    description: "Create consistent characters across images and videos for storytelling",
    type: "static",
    media: `${STATIC_MEDIA}/quiz-v2/auth-3.png`,
    badges: [
      { icon: <DiamondIcon />, label: "2K Quality" },
      { icon: <Icon as={WandSparkles} size="sm" />, label: "Prompt Enhancer" },
    ],
  },
  {
    id: "cinematic-app",
    title: "CINEMA STUDIO",
    description: "Turn images into cinematic shots with motion and transitions",
    type: "video",
    media: `${STATIC_MEDIA}/quiz-v2/auth-5-mini.mp4`,
    thumbnail: `${STATIC_MEDIA}/quiz-v2/auth-5-mini-thumbnail.webp`,
    badges: [
      { icon: <Icon as={Check} size="sm" />, label: "Cinematic Motion" },
      { icon: <Icon as={Check} size="sm" />, label: "Film-grade Shots" },
    ],
  },
];

const tabLabels = ["Seedance 2.0 4K", "Nano Banana Pro", "Higgsfield Soul", "Cinematic App"];

function AuthShowcaseSlider() {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const animationFrameRef = useRef<number | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const progressBarRefs = useRef<(HTMLDivElement | null)[]>([]);
  const selectedIndexRef = useRef(0);

  const setBarWidth = useCallback((index: number, pct: number) => {
    const bar = progressBarRefs.current[index];
    if (bar) bar.style.width = `${pct}%`;
  }, []);

  const selectSlide = useCallback((index: number) => {
    selectedIndexRef.current = index;
    setSelectedIndex(index);
  }, []);

  const startProgress = useCallback(() => {
    if (animationFrameRef.current != null) cancelAnimationFrame(animationFrameRef.current);
    startTimeRef.current = null;
    for (let index = 0; index < tabLabels.length; index += 1) {
      setBarWidth(index, index < selectedIndexRef.current ? 100 : 0);
    }

    const animate = (timestamp: number) => {
      startTimeRef.current ??= timestamp;
      const progress = Math.min(((timestamp - startTimeRef.current) / SLIDE_DURATION) * 100, 100);
      setBarWidth(selectedIndexRef.current, progress);
      if (progress < 100) animationFrameRef.current = requestAnimationFrame(animate);
      else selectSlide((selectedIndexRef.current + 1) % slides.length);
    };
    animationFrameRef.current = requestAnimationFrame(animate);
  }, [selectSlide, setBarWidth]);

  useEffect(() => {
    startProgress();
    return () => {
      if (animationFrameRef.current != null) cancelAnimationFrame(animationFrameRef.current);
    };
  }, [selectedIndex, startProgress]);

  return (
    <div className="relative flex size-full flex-col overflow-hidden rounded-q-400 bg-black">
      <div className="flex-1 overflow-hidden">
        <div
          className="flex h-full transition-transform duration-500 ease-out"
          style={{ transform: `translateX(-${selectedIndex * 100}%)` }}
        >
          {slides.map((slide) => (
            <div key={slide.id} className="relative h-full min-w-0 flex-[0_0_100%]">
              {slide.type === "video" ? (
                <video
                  src={slide.media}
                  poster={slide.thumbnail}
                  className="absolute inset-0 size-full object-cover"
                  autoPlay
                  loop
                  muted
                  playsInline
                />
              ) : (
                <img
                  src={slide.media}
                  alt={slide.title}
                  className="absolute inset-0 size-full object-cover"
                />
              )}
              <div className="absolute inset-0 bg-gradient-to-b from-transparent via-black/20 to-black/80" />
            </div>
          ))}
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-8 p-5">
        <div className="flex flex-col gap-3">
          <div className="flex gap-1">
            {slides[selectedIndex].badges.map((badge) => (
              <span
                key={badge.label}
                className="inline-flex items-center gap-1 rounded-q-200 bg-white/10 px-2 py-1 text-[10px] font-semibold leading-[14px] text-white backdrop-blur-xl"
              >
                {badge.icon}
                {badge.label}
              </span>
            ))}
          </div>
          <div className="flex flex-col gap-1.5">
            <h2 className="text-q-accent-2xl-bold uppercase">{slides[selectedIndex].title}</h2>
            <p className="text-q-body-sm-regular text-white/50">
              {slides[selectedIndex].description}
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex gap-1">
            {tabLabels.map((label, index) => (
              <button
                key={label}
                type="button"
                onClick={() => selectSlide(index)}
                aria-label={`Show ${label}`}
                className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-white/20"
              >
                <div
                  ref={(element) => {
                    progressBarRefs.current[index] = element;
                  }}
                  className="h-full rounded-full bg-white"
                />
              </button>
            ))}
          </div>
          <div className="flex gap-1">
            {tabLabels.map((label, index) => (
              <button
                key={label}
                type="button"
                onClick={() => selectSlide(index)}
                className={`min-w-0 flex-1 truncate text-left text-xs leading-[18px] transition-colors ${
                  selectedIndex === index
                    ? "font-medium text-white"
                    : "font-normal text-white/40 hover:text-white/60"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export interface SignInModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  signInUrl: string | null;
}

export function SignInModal({ open, onOpenChange, signInUrl }: SignInModalProps) {
  const logIn = () => {
    if (signInUrl != null) window.location.assign(signInUrl);
  };

  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content
        size="xl"
        backdropClassName="!z-[39] !bg-[rgba(0,0,0,0.8)]"
        className="h-[690px] w-[948px] max-w-[calc(100vw-2rem)] border border-white/5"
      >
        <Modal.Header>
          <Modal.Title>Log in</Modal.Title>
          <Modal.CloseButton />
        </Modal.Header>

        <Modal.Body className="overflow-hidden">
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 md:grid-cols-[minmax(0,580px)_minmax(280px,342px)]">
            <Modal.Workspace padded={false} className="hidden overflow-hidden md:block">
              <AuthShowcaseSlider />
            </Modal.Workspace>

            <Modal.Workspace
              padded={false}
              className="relative flex min-h-[420px] flex-col items-center text-center"
            >
              <div className="flex h-[557px] w-full flex-col items-center justify-center gap-8">
                <span className="flex size-10 items-center justify-center overflow-hidden rounded-[10px] border-[1.429px] border-white/25 bg-q-brand-primary p-[2.857px] text-q-text-inverse shadow-[inset_0_2.857px_5.714px_rgba(255,255,255,0.24),0_5.714px_5.714px_rgba(0,0,0,0.08)]">
                  <HiggsfieldMark className="size-[34.286px] shrink-0" />
                </span>

                <div className="flex flex-col items-center gap-2">
                  <h2 className="text-q-accent-2xl-bold uppercase">
                    Welcome
                    <br />
                    to Higgsfield
                  </h2>
                  <p className="text-q-body-md-medium text-white/40">Sign up and generate</p>
                </div>

                <Button
                  variant="marketingPrimary"
                  size="md"
                  start={<HiggsfieldMark className="size-6" />}
                  onClick={logIn}
                >
                  Log in Higgsfield
                </Button>
              </div>

              <p className="absolute inset-x-[18px] bottom-3.5 text-q-caption-xs-regular text-white/30">
                By continuing, I acknowledge the{" "}
                <a
                  href="https://higgsfield.ai/privacy-policy"
                  target="_blank"
                  rel="noreferrer"
                  className="text-white/40 underline"
                >
                  Privacy Policy
                </a>{" "}
                and agree to the{" "}
                <a
                  href="https://higgsfield.ai/terms-of-use-agreement"
                  target="_blank"
                  rel="noreferrer"
                  className="text-white/40 underline"
                >
                  Terms of Use
                </a>
                . I also confirm that I am at least 18 years old
              </p>
            </Modal.Workspace>
          </div>
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}
