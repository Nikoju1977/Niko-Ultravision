"use client";

import type { FormEvent, MouseEvent } from "react";
import { useId, useState } from "react";
import { Ellipsis as IconMore, Pencil as IconRename, Trash2 as IconDelete } from "lucide-react";
import { Button } from "@higgsfield/quanta/button";
import { Dropdown } from "@higgsfield/quanta/dropdown";
import { Icon } from "@higgsfield/quanta/icon";
import { Input } from "@higgsfield/quanta/input";
import { Modal } from "@higgsfield/quanta/modal";
import { Typography } from "@higgsfield/quanta/typography";

export interface ProjectActionsProps {
  projectName: string;
  onRename: (name: string) => Promise<void>;
  onDelete: () => Promise<void>;
}

function stopPropagation(event: MouseEvent) {
  event.stopPropagation();
}

export function ProjectActions({ projectName, onRename, onDelete }: ProjectActionsProps) {
  const formId = useId();
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [name, setName] = useState(projectName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmedName = name.trim();

  const openRename = () => {
    setName(projectName);
    setError(null);
    setRenameOpen(true);
  };

  const handleRename = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!trimmedName || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onRename(trimmedName);
      setRenameOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not rename project.");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onDelete();
      setDeleteOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete project.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Dropdown.Root>
        <Dropdown.Trigger
          aria-label={`Project actions for ${projectName}`}
          className="flex size-7 items-center justify-center rounded-q-full text-q-icon-secondary hover:bg-q-transparent-light-10 hover:text-q-icon-primary focus-visible:outline-2 focus-visible:outline-q-border-focus"
          onPointerDown={stopPropagation}
          onClick={stopPropagation}
        >
          <Icon as={IconMore} size="sm" />
        </Dropdown.Trigger>
        <Dropdown.Content surface="solid" side="right" align="start" sideOffset={6}>
          <Dropdown.Item
            value="rename"
            title="Rename"
            start={<Icon as={IconRename} size="sm" />}
            onSelect={openRename}
          />
          <Dropdown.Item
            value="delete"
            title="Delete"
            danger
            start={<Icon as={IconDelete} size="sm" />}
            onSelect={() => {
              setError(null);
              setDeleteOpen(true);
            }}
          />
        </Dropdown.Content>
      </Dropdown.Root>

      <Modal.Root open={renameOpen} onOpenChange={setRenameOpen}>
        <Modal.Content size="sm">
          <Modal.Header>
            <Modal.Title>Rename project</Modal.Title>
            <Modal.CloseButton />
          </Modal.Header>
          <Modal.Body>
            <form id={formId} onSubmit={handleRename}>
              <Input
                required
                autoFocus
                label="Project name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                error={error}
              />
            </form>
          </Modal.Body>
          <Modal.Footer>
            <Modal.FooterActions>
              <Modal.Close render={<Button variant="ghost" size="md" disabled={busy} />}>
                Cancel
              </Modal.Close>
              <Button
                type="submit"
                form={formId}
                variant="secondary"
                size="md"
                disabled={!trimmedName || busy}
              >
                {busy ? "Saving…" : "Save"}
              </Button>
            </Modal.FooterActions>
          </Modal.Footer>
        </Modal.Content>
      </Modal.Root>

      <Modal.Root open={deleteOpen} onOpenChange={setDeleteOpen}>
        <Modal.Content size="sm">
          <Modal.Header>
            <Modal.Title>Delete project?</Modal.Title>
            <Modal.CloseButton />
          </Modal.Header>
          <Modal.Body>
            <Typography as="p" variant="body-sm-regular" color="secondary">
              “{projectName}” will be removed. Its generations will remain in All Generations.
            </Typography>
            {error != null ? (
              <Typography as="p" variant="caption-sm-regular" color="danger" className="mt-2">
                {error}
              </Typography>
            ) : null}
          </Modal.Body>
          <Modal.Footer>
            <Modal.FooterActions>
              <Modal.Close render={<Button variant="ghost" size="md" disabled={busy} />}>
                Cancel
              </Modal.Close>
              <Button variant="secondary" size="md" disabled={busy} onClick={handleDelete}>
                {busy ? "Deleting…" : "Delete"}
              </Button>
            </Modal.FooterActions>
          </Modal.Footer>
        </Modal.Content>
      </Modal.Root>
    </>
  );
}
