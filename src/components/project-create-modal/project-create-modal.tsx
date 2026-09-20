"use client";

import type { FormEvent, ReactElement } from "react";
import { useState } from "react";
import { useFnfScopeKey } from "@higgsfield/fnf-react";
import { Button } from "@higgsfield/quanta/button";
import { Loader } from "@higgsfield/quanta/loader";
import { Typography } from "@higgsfield/quanta/typography";
import { Modal } from "@higgsfield/quanta/modal";
import { SignInModal } from "@/components/sign-in-modal";
import { getSignInUrl, GUEST_SCOPE_KEY } from "@/lib/fnf.browser";
import "./project-create-modal.css";

export interface ProjectCreateModalProps {
  trigger: ReactElement;
  onCreate: (name: string) => void | Promise<void>;
}

export function ProjectCreateModal({ trigger, onCreate }: ProjectCreateModalProps) {
  const scopeKey = useFnfScopeKey();
  const [open, setOpen] = useState(false);
  const [pendingSignInUrl, setPendingSignInUrl] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmedName = name.trim();

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && saving) return;
    if (nextOpen) {
      const signInUrl = getSignInUrl(
        scopeKey ?? GUEST_SCOPE_KEY,
        `${window.location.pathname}${window.location.search}${window.location.hash}`,
      );
      if (signInUrl != null) {
        setPendingSignInUrl(signInUrl);
        return;
      }
    }
    if (nextOpen && !open) setError(null);
    setOpen(nextOpen);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!trimmedName || saving) return;

    setSaving(true);
    setError(null);
    try {
      await onCreate(trimmedName);
      setName("");
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The project could not be created.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal.Root open={open} onOpenChange={handleOpenChange}>
      <SignInModal
        open={pendingSignInUrl != null}
        signInUrl={pendingSignInUrl}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setPendingSignInUrl(null);
        }}
      />
      <Modal.Trigger render={trigger} />
      <Modal.Content size="sm" className="project-create-modal">
        <Modal.Header>
          <Modal.Title>New project</Modal.Title>
          <Modal.CloseButton disabled={saving} />
        </Modal.Header>
        <form className="project-create-modal-form" onSubmit={handleSubmit}>
          <label className="sr-only" htmlFor="project-create-name">
            Project name
          </label>
          <div className="project-create-modal-name-field">
            <input
              id="project-create-name"
              required
              autoFocus
              autoComplete="off"
              maxLength={80}
              placeholder="Project name"
              value={name}
              disabled={saving}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          {error != null ? (
            <Typography as="p" variant="caption-sm-regular" color="danger">
              {error}
            </Typography>
          ) : null}
          <Button
            type="submit"
            variant="secondary"
            size="md"
            className="motion-press w-full"
            disabled={!trimmedName || saving}
            start={
              saving ? (
                <Loader size="xs" color="neutral" aria-label="Creating project" />
              ) : undefined
            }
          >
            {saving ? "Creating…" : "Create"}
          </Button>
        </form>
      </Modal.Content>
    </Modal.Root>
  );
}
