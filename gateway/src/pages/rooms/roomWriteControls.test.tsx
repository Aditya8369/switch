import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import RoomLinkedRoomsSection from "./RoomLinkedRoomsSection";
import RoomResourcesSection from "./RoomResourcesSection";

// The room's linked rooms and resources change only for someone with write
// access to the room, so their controls show only to them.

const result = <T,>(data: T) => ({
  data,
  loading: false,
  error: null,
  refetch: vi.fn(),
});

vi.mock("../../data/hooks", () => ({
  useLinkedRooms: () =>
    result([
      {
        target_room_id: "r2",
        target_room_name: "other",
        target_room_description: "",
        label: "see also",
      },
    ]),
  useRooms: () => result([]),
  useRoomReferences: () =>
    result([
      {
        id: "ref1",
        name: "spec",
        description: "",
        type: "url",
        type_display_name: "URL",
        packages: [],
      },
    ]),
  useReferences: () => result([]),
  useRoomDocuments: () =>
    result([
      { id: "doc1", name: "notes", description: "", scope: "global", packages: [] },
    ]),
  useDocuments: () => result([]),
  useRoomPackages: () => result([{ id: "pkg1", name: "kit", description: "" }]),
  usePackages: () => result([]),
}));

afterEach(cleanup);

function renderSections(canWrite: boolean) {
  render(
    <MemoryRouter>
      <RoomResourcesSection roomId="r1" canWrite={canWrite} />
      <RoomLinkedRoomsSection roomId="r1" canWrite={canWrite} />
    </MemoryRouter>,
  );
}

const ADD_BUTTONS = [
  "Attach reference",
  "Attach document",
  "Attach package",
  "Add linked room",
];

describe("room resources and linked rooms", () => {
  it("offer no attach, detach or link controls without write access", () => {
    renderSections(false);

    expect(screen.getByText("spec")).toBeTruthy();
    expect(screen.getByText("other")).toBeTruthy();
    for (const name of ADD_BUTTONS) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.queryByTestId("DeleteOutlineIcon")).toBeNull();
  });

  it("offer them with write access", () => {
    renderSections(true);

    for (const name of ADD_BUTTONS) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    expect(screen.getAllByTestId("DeleteOutlineIcon")).toHaveLength(4);
  });
});
