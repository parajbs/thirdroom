import { useState, ReactNode } from "react";
import { Room, RoomMember } from "@thirdroom/hydrogen-view-sdk";

import { Dialog } from "../../../atoms/dialog/Dialog";
import { Header } from "../../../atoms/header/Header";
import { HeaderTitle } from "../../../atoms/header/HeaderTitle";
import { IconButton } from "../../../atoms/button/IconButton";
import CrossIC from ".././../../../../res/ic/cross.svg";
import { MemberTile } from "../../components/member-tile/MemberTile";
import { Avatar } from "../../../atoms/avatar/Avatar";
import { Text } from "../../../atoms/text/Text";
import { Scroll } from "../../../atoms/scroll/Scroll";
import { useRoomMembers } from "../../../hooks/useRoomMembers";
import { getAvatarHttpUrl, getIdentifierColorNumber } from "../../../utils/avatar";
import { useHydrogen } from "../../../hooks/useHydrogen";
import { DropdownMenu } from "../../../atoms/menu/DropdownMenu";
import MoreHorizontalIC from "../../../../../res/ic/more-horizontal.svg";
import ChevronBottomIC from "../../../../../res/ic/chevron-bottom.svg";
import ChevronRightIC from "../../../../../res/ic/chevron-right.svg";
import { DropdownMenuItem } from "../../../atoms/menu/DropdownMenuItem";
import { Category } from "../../components/category/Category";
import { CategoryHeader } from "../../components/category/CategoryHeader";
import { Icon } from "../../../atoms/icon/Icon";
import { usePowerLevels } from "../../../hooks/usePowerLevels";

interface MemberListDialogProps {
  room: Room;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  requestClose: () => void;
}

export function MemberListDialog({ room, isOpen, onOpenChange, requestClose }: MemberListDialogProps) {
  const { session, platform } = useHydrogen(true);

  const { invited, joined, leaved, banned } = useRoomMembers(room) ?? {};
  const { canDoAction, getPowerLevel } = usePowerLevels(room);
  const myPL = getPowerLevel(session.userId);
  const canInvite = canDoAction("invite", myPL);
  const canKick = canDoAction("kick", myPL);
  const canBan = canDoAction("ban", myPL);

  const [joinedCat, setJoinedCat] = useState(true);
  const [invitedCat, setInvitedCat] = useState(true);
  const [leaveCat, setLeaveCat] = useState(true);
  const [banCat, setBanCat] = useState(true);

  const invite = (roomId: string, userId: string) => session.hsApi.invite(roomId, userId);
  const disInvite = (roomId: string, userId: string) => session.hsApi.kick(roomId, userId);
  const kick = (roomId: string, userId: string) => session.hsApi.kick(roomId, userId);
  const ban = (roomId: string, userId: string) => session.hsApi.ban(roomId, userId);
  const unban = (roomId: string, userId: string) => session.hsApi.unban(roomId, userId);

  const renderMemberTile = (member: RoomMember) => {
    const { userId, name, avatarUrl, membership } = member;
    const userPL = getPowerLevel(userId);

    const menuItems: ReactNode[] = [];
    switch (membership) {
      case "join":
        if (canKick && myPL > userPL)
          menuItems.push(
            <DropdownMenuItem key="kick" onSelect={() => kick(room.id, userId)}>
              Kick
            </DropdownMenuItem>
          );
        if (canBan && myPL > userPL)
          menuItems.push(
            <DropdownMenuItem key="ban" onSelect={() => ban(room.id, userId)}>
              Ban
            </DropdownMenuItem>
          );
        break;
      case "ban":
        if (canKick && myPL > userPL)
          menuItems.push(
            <DropdownMenuItem key="unban" onSelect={() => unban(room.id, userId)}>
              Unban
            </DropdownMenuItem>
          );
        break;
      case "invite":
        if (canKick && myPL > userPL)
          menuItems.push(
            <DropdownMenuItem key="disinvite" onSelect={() => disInvite(room.id, userId)}>
              Disinvite
            </DropdownMenuItem>
          );
        break;
      case "leave":
        if (canInvite)
          menuItems.push(
            <DropdownMenuItem key="invite" onSelect={() => invite(room.id, userId)}>
              Invite
            </DropdownMenuItem>
          );
        break;
    }

    return (
      <MemberTile
        key={userId}
        avatar={
          <Avatar
            shape="circle"
            name={name}
            imageSrc={avatarUrl && getAvatarHttpUrl(avatarUrl, 40, platform, session.mediaRepository)}
            bgColor={`var(--usercolor${getIdentifierColorNumber(userId)})`}
          />
        }
        content={
          <>
            <Text className="truncate" weight="medium">
              {name}
            </Text>
            <Text className="truncate" color="surface-low" variant="b3">
              {userId}
            </Text>
          </>
        }
        options={
          menuItems.length > 0 &&
          userId !== session.userId && (
            <DropdownMenu content={menuItems}>
              <IconButton variant="surface-low" label="Options" iconSrc={MoreHorizontalIC} />
            </DropdownMenu>
          )
        }
      />
    );
  };
  return (
    <>
      <Dialog open={isOpen} onOpenChange={onOpenChange}>
        <Header
          left={<HeaderTitle size="lg">Members</HeaderTitle>}
          right={<IconButton iconSrc={CrossIC} onClick={requestClose} label="Close" />}
        />
        <div className="flex" style={{ height: "600px" }}>
          <Scroll type="hover" style={{ paddingBottom: "var(--sp-lg)" }}>
            <div className="flex flex-column gap-sm">
              {!!invited?.length && (
                <Category
                  header={
                    <CategoryHeader
                      title="Invited"
                      onClick={() => setInvitedCat(!invitedCat)}
                      after={<Icon src={invitedCat ? ChevronBottomIC : ChevronRightIC} />}
                    />
                  }
                >
                  {invitedCat && invited.map(renderMemberTile)}
                </Category>
              )}
              {!!joined?.length && (
                <Category
                  header={
                    <CategoryHeader
                      title="Joined"
                      onClick={() => setJoinedCat(!joinedCat)}
                      after={<Icon src={joinedCat ? ChevronBottomIC : ChevronRightIC} />}
                    />
                  }
                >
                  {joinedCat && joined.map(renderMemberTile)}
                </Category>
              )}

              {!!banned?.length && (
                <Category
                  header={
                    <CategoryHeader
                      title="Banned"
                      onClick={() => setBanCat(!banCat)}
                      after={<Icon src={banCat ? ChevronBottomIC : ChevronRightIC} />}
                    />
                  }
                >
                  {banCat && banned.map(renderMemberTile)}
                </Category>
              )}
              {!!leaved?.length && (
                <Category
                  header={
                    <CategoryHeader
                      title="Archived"
                      onClick={() => setLeaveCat(!leaveCat)}
                      after={<Icon src={leaveCat ? ChevronBottomIC : ChevronRightIC} />}
                    />
                  }
                >
                  {leaveCat && leaved.map(renderMemberTile)}
                </Category>
              )}
            </div>
          </Scroll>
        </div>
      </Dialog>
    </>
  );
}
